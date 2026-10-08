import { isIP } from 'node:net'
import { KernelError } from '#errors'

/** Canonicalizes socket addresses and shares one anonymous quota bucket across an IPv6 /64. */
export function networkAddress(input: string): { address: string; bucket: string } {
  const family = isIP(input);
  if (family === 4) return { address: input, bucket: input };
  if (family !== 6) throw new KernelError('INVALID', 'Invalid network origin');
  const address = new URL(`http://[${input.split('%')[0]}]`).hostname.slice(1, -1);
  const [left, right] = address.split('::');
  const before = left === '' ? [] : left.split(':');
  const after = right === undefined || right === '' ? [] : right.split(':');
  const words =
    right === undefined
      ? before
      : [...before, ...Array<string>(8 - before.length - after.length).fill('0'), ...after];
  if (words.slice(0, 5).every((word) => Number.parseInt(word, 16) === 0) && words[5] === 'ffff') {
    const a = Number.parseInt(words[6], 16);
    const b = Number.parseInt(words[7], 16);
    const ipv4 = `${a >>> 8}.${a & 255}.${b >>> 8}.${b & 255}`;
    return { address: ipv4, bucket: ipv4 };
  }
  return {
    address,
    bucket: `${words
      .slice(0, 4)
      .map((word) => Number.parseInt(word, 16).toString(16))
      .join(':')}/64`,
  };
}
