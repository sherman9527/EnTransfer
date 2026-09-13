// Generate proper multi-size ICO from PNG using png-to-ico library
import fs from 'node:fs'
import pngToIco from 'png-to-ico'

const input = process.argv[2] || 'assets/icon.png'
const output = process.argv[3] || 'assets/icon.ico'

const buf = await pngToIco(input)
fs.writeFileSync(output, buf)
console.log(`ICO generated: ${output} (${(buf.length / 1024).toFixed(1)} KB)`)

// Verify
const header = buf.slice(0, 6)
const count = header.readUInt16LE(4)
console.log(`Image count: ${count}`)
for (let i = 0; i < count; i++) {
  const off = 6 + i * 16
  const w = buf.readUInt8(off) || 256
  const h = buf.readUInt8(off + 1) || 256
  const bpp = buf.readUInt16LE(off + 6)
  const size = buf.readUInt32LE(off + 8)
  console.log(`  ${w}x${h}, ${bpp}bpp, ${(size / 1024).toFixed(1)}KB`)
}
