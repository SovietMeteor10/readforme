import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

for (const size of [16, 48, 128]) {
  writeFileSync(`icons/icon${size}.png`, makePng(size));
}

function makePng(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const bg = [22, 22, 22, 255];
  const fg = [255, 255, 255, 255];

  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    pixels[row] = 0;
    for (let x = 0; x < size; x += 1) setPixel(pixels, size, x, y, bg);
  }

  const rect = [0.24 * size, 0.34 * size, 0.45 * size, 0.66 * size];
  const cone = [
    [0.45 * size, 0.34 * size],
    [0.75 * size, 0.16 * size],
    [0.75 * size, 0.84 * size],
    [0.45 * size, 0.66 * size]
  ];
  const arcX = 0.79 * size;
  const arcY = 0.5 * size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const insideRect = x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];
      const insideCone = inPolygon(x, y, cone);
      const dx = x - arcX;
      const dy = y - arcY;
      const d = Math.sqrt(dx * dx + dy * dy);
      const onArc = x > arcX && d > 0.14 * size && d < 0.18 * size && Math.abs(dy) < 0.26 * size;
      if (insideRect || insideCone || onArc) setPixel(pixels, size, x, y, fg);
    }
  }

  const header = Buffer.from('\x89PNG\r\n\x1a\n', 'binary');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = deflateSync(pixels);
  return Buffer.concat([header, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function setPixel(buffer, size, x, y, rgba) {
  const offset = y * (size * 4 + 1) + 1 + x * 4;
  buffer[offset] = rgba[0];
  buffer[offset + 1] = rgba[1];
  buffer[offset + 2] = rgba[2];
  buffer[offset + 3] = rgba[3];
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function inPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
