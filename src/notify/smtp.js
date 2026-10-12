// 极简 SMTP 客户端：只做"发一封纯文本邮件"这一件事，所以自己实现，不引入依赖。
//
// 覆盖范围：明文、STARTTLS、隐式 TLS（465），AUTH LOGIN / PLAIN。
// 内网 relay 基本都在这个范围内；需要 OAuth 之类的高级认证时请改用外部命令或专门的发信服务。
//
// 网络层通过 connect 注入，单测里可以喂一个脚本化的假 socket 来验证协议流程。
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';

const CRLF = '\r\n';

function defaultConnect({ host, port, secure }) {
  return secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
}

/**
 * 把 socket 封成一个"能按 SMTP 回复读取"的信道。
 * SMTP 回复可能是多行（250-xxx 续行，最后一行是 250 xxx），所以要按行累积到完整的回复。
 */
function createChannel(socket, onError) {
  let buffer = '';
  const lines = [];
  let waiter = null;
  let failure = null;

  function takeReply() {
    if (lines.length === 0) return null;
    const collected = [];
    while (lines.length > 0) {
      const line = lines.shift();
      collected.push(line);
      if (/^\d{3}(\s|$)/.test(line)) {
        return { code: Number(line.slice(0, 3)), text: collected.join('\n') };
      }
    }
    lines.unshift(...collected);
    return null;
  }

  function pump() {
    if (!waiter) return;
    if (failure) {
      const current = waiter;
      waiter = null;
      current.reject(failure);
      return;
    }
    const reply = takeReply();
    if (!reply) return;
    const current = waiter;
    waiter = null;
    current.resolve(reply);
  }

  socket.setEncoding?.('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      lines.push(buffer.slice(0, index).replace(/\r$/, ''));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
    pump();
  });
  socket.on('error', (error) => {
    failure = error;
    onError?.(error);
    pump();
  });
  socket.on('close', () => {
    failure = failure || new Error('SMTP 连接被关闭');
    pump();
  });

  return {
    socket,
    read() {
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        pump();
      });
    },
    write(text) {
      socket.write(text);
    },
    close() {
      try {
        socket.end();
      } catch {
        // 已经断开就无所谓
      }
    },
  };
}

function withTimeout(promise, timeoutMs, step) {
  if (!(timeoutMs > 0)) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${step} 超时（${timeoutMs} ms）`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 非 ASCII 的头（中文主题、中文发件人名）要按 RFC 2047 编码 */
export function encodeHeader(text) {
  const value = String(text ?? '');
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function buildMessage({ from, to, subject, text, date = new Date() }) {
  const recipients = Array.isArray(to) ? to : [to];
  const body = Buffer.from(String(text ?? ''), 'utf8').toString('base64');
  const lines = [
    `From: ${encodeHeader(from)}`,
    `To: ${recipients.map((item) => encodeHeader(item)).join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@gpu-monitor>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    // 正文用 base64：中文正文在任何只认 7bit 的 relay 上都不会被改坏
    'Content-Transfer-Encoding: base64',
    '',
  ];
  // 正文按 76 字符折行，符合 RFC 2045
  for (let i = 0; i < body.length; i += 76) lines.push(body.slice(i, i + 76));
  return lines.join(CRLF);
}

export async function sendMail({
  host,
  port = 587,
  secure = false,
  starttls = true,
  user,
  pass,
  from,
  to,
  subject,
  text,
  timeoutMs = 20000,
  connect = defaultConnect,
  clientName = os.hostname() || 'gpu-monitor',
} = {}) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!host) throw new Error('缺少 SMTP 服务器地址');
  if (!from) throw new Error('缺少发件人地址');
  if (recipients.length === 0) throw new Error('缺少收件人地址');

  let socket = connect({ host, port, secure });
  let channel = createChannel(socket);

  const step = async (codes, name) => {
    const reply = await withTimeout(channel.read(), timeoutMs, name);
    if (!codes.includes(reply.code)) {
      throw new Error(`${name} 失败：SMTP 返回 ${reply.text.split('\n')[0]}`);
    }
    return reply;
  };

  try {
    await step([220], '连接 SMTP 服务器');

    channel.write(`EHLO ${clientName}${CRLF}`);
    let ehlo = await step([250], 'EHLO');

    if (!secure && starttls && /STARTTLS/i.test(ehlo.text)) {
      channel.write(`STARTTLS${CRLF}`);
      await step([220], 'STARTTLS');
      // 升级前解绑明文 socket 上的监听：否则同一批数据会被新旧两个信道各读一遍
      socket.removeAllListeners();
      socket = await new Promise((resolve, reject) => {
        const upgraded = tls.connect({ socket, servername: host, host }, () => resolve(upgraded));
        upgraded.once('error', reject);
      });
      channel = createChannel(socket);
      channel.write(`EHLO ${clientName}${CRLF}`);
      ehlo = await step([250], 'STARTTLS 后的 EHLO');
    }

    if (user) {
      if (!/AUTH/i.test(ehlo.text)) {
        throw new Error('服务器没有声明 AUTH，无法带账号密码登录');
      }
      channel.write(`AUTH LOGIN${CRLF}`);
      await step([334], 'AUTH LOGIN');
      channel.write(`${Buffer.from(String(user), 'utf8').toString('base64')}${CRLF}`);
      await step([334], '发送用户名');
      channel.write(`${Buffer.from(String(pass ?? ''), 'utf8').toString('base64')}${CRLF}`);
      await step([235], '发送密码');
    }

    channel.write(`MAIL FROM:<${from}>${CRLF}`);
    await step([250], 'MAIL FROM');

    for (const recipient of recipients) {
      channel.write(`RCPT TO:<${recipient}>${CRLF}`);
      await step([250, 251], `RCPT TO ${recipient}`);
    }

    channel.write(`DATA${CRLF}`);
    await step([354], 'DATA');

    const message = buildMessage({ from, to: recipients, subject, text });
    channel.write(`${message}${CRLF}.${CRLF}`);
    await step([250], '投递正文');

    channel.write(`QUIT${CRLF}`);
    return { ok: true, recipients };
  } finally {
    channel.close();
  }
}
