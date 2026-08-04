// 纯函数：把长度 len 切成 [from,to) 区间数组，供 setDocStreaming 分块插入复用，
// 也便于独立单测（不依赖 CodeMirror / DOM）。
export function chunkRanges(len: number, chunk: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (len <= 0) return out;
  for (let p = 0; p < len; p += chunk) out.push([p, Math.min(p + chunk, len)]);
  return out;
}
