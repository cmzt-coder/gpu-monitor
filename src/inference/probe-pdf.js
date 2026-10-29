// MinerU 探针用的一页 PDF 生成器。
//
// 为什么在内存里拼而不是带一个二进制样品文件：
//   - 项目坚持零依赖、仓库里不放二进制资产；
//   - 一个不含压缩流的单页 PDF 只有几百字节，手写完全可控；
//   - 每次探针都重新生成，不受工作目录和打包方式影响。
//
// 生成结果是最小合法 PDF（Helvetica 一行文字），pdfium / pdfminer / PyMuPDF 都能解析。

function escapeText(value) {
  return String(value).replace(/([\\()])/g, '\\$1');
}

/**
 * 生成一页 PDF，返回 Buffer。
 * 文本只支持 ASCII：内置探针只用固定英文，避免编码问题。
 */
export function buildProbePdf(text = 'gpu-monitor probe') {
  const content = `BT /F1 18 Tf 60 760 Td (${escapeText(text)}) Tj ET\n`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
  ];

  const chunks = [];
  let offset = 0;
  const push = (value) => {
    const buffer = Buffer.from(value, 'latin1');
    chunks.push(buffer);
    offset += buffer.length;
  };

  push('%PDF-1.4\n');
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const value of offsets) xref += `${String(value).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}
