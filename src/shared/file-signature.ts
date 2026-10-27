/** NUL is not a reliable binary detector: PDFs and ZIP-based Office files can
 * contain long UTF-8/ASCII runs. Recognize their signatures before text decode. */
export function hasBinaryFileSignature(sample: Uint8Array): boolean {
  if (sample.includes(0)) return true
  if (sample.length >= 5 && sample[0] === 0x25 && sample[1] === 0x50 && sample[2] === 0x44 && sample[3] === 0x46 && sample[4] === 0x2d) return true
  return sample.length >= 4 && sample[0] === 0x50 && sample[1] === 0x4b &&
    (sample[2] === 3 && sample[3] === 4 || sample[2] === 5 && sample[3] === 6 || sample[2] === 7 && sample[3] === 8)
}

export function hasOfficeFileSignature(sample: Uint8Array, name: string): boolean {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (extension === 'pdf') return sample.length >= 5 && sample[0] === 0x25 && sample[1] === 0x50 && sample[2] === 0x44 && sample[3] === 0x46 && sample[4] === 0x2d
  if (!['docx', 'xlsx', 'pptx'].includes(extension)) return false
  return sample.length >= 4 && sample[0] === 0x50 && sample[1] === 0x4b &&
    (sample[2] === 3 && sample[3] === 4 || sample[2] === 5 && sample[3] === 6 || sample[2] === 7 && sample[3] === 8)
}
