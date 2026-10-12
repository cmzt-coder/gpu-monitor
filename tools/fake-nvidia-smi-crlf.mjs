#!/usr/bin/env node
// 同一个假 nvidia-smi，只是强制输出 CRLF（模拟 Windows 上的输出），用于解析回归测试
process.env.FAKE_SMI_CRLF = '1';
await import('./fake-nvidia-smi.mjs');
