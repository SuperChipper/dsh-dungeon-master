/**
 * sharp 是可选依赖：没装时画图功能各自退回文字，不能让插件起不来，所以只能动态 import。
 *
 * 类型由调用方给：每处只声明自己用到的那几个方法，这里不引 sharp 的类型（没装时没有）。
 */
let sharpPromise: Promise<unknown> | undefined;

export async function loadSharp<T>(): Promise<T | undefined> {
  sharpPromise ??= import('sharp')
    .then((mod) => (mod as { default?: unknown }).default ?? mod)
    .catch(() => undefined);
  return sharpPromise as Promise<T | undefined>;
}
