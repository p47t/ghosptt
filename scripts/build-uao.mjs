import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function main() {
  console.log('Fetching table.go from ptt/pttbbs main branch...');
  const res = await fetch(
    'https://raw.githubusercontent.com/ptt/pttbbs/main/service/big5uao/table.go'
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch table.go: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();

  const mb = text.match(/var b2uTable = \[65536\]uint16\{([^}]+)\}/s);
  if (!mb) throw new Error('b2uTable not found in table.go');
  const b2u = mb[1].match(/0x[0-9a-fA-F]+/g).map((x) => parseInt(x, 16));

  const mu = text.match(/var u2bTable = \[65536\]uint16\{([^}]+)\}/s);
  if (!mu) throw new Error('u2bTable not found in table.go');
  const u2b = mu[1].match(/0x[0-9a-fA-F]+/g).map((x) => parseInt(x, 16));

  if (b2u.length !== 65536 || u2b.length !== 65536) {
    throw new Error(
      `Invalid table lengths: b2u=${b2u.length}, u2b=${u2b.length}`
    );
  }

  const outBuf = Buffer.alloc(65536 * 2 + 65536 * 2);
  for (let i = 0; i < 65536; i++) {
    outBuf.writeUInt16LE(b2u[i], i * 2);
    outBuf.writeUInt16LE(u2b[i], 65536 * 2 + i * 2);
  }

  const outPath = path.join(ROOT, 'public', 'uao250.bin');
  fs.writeFileSync(outPath, outBuf);
  console.log(`Generated ${outPath} (${outBuf.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
