/**
 * 状态预览开关：`?state=empty` / `loading` / `stale` / `failing` / `error`
 *
 * 空态、加载态、陈旧态在正常使用中几乎看不到 —— 空态只有新用户第一次打开时出现，
 * 陈旧态要等上游真的挂掉。没有这个开关，每次想看一眼都得改代码再 build，
 * 结果就是这几屏改完一次再没人验证过。
 *
 * 只影响 UI 分支，不碰数据，也不写任何持久状态，所以生产环境也保留 ——
 * 部署后随时能对着真机核对这几屏。
 */
export type PreviewState = 'empty' | 'loading' | 'stale' | 'failing' | 'error';

const VALID: PreviewState[] = ['empty', 'loading', 'stale', 'failing', 'error'];

export function previewState(): PreviewState | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('state');
  return VALID.includes(v as PreviewState) ? (v as PreviewState) : null;
}
