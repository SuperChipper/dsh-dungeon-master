/**
 * DSH 浏览器端宿主契约适配层（供 `src/client/` 下严格 DOM 编译使用，不依赖 Node 模块）。
 */
import type { Context } from '@deepseek-ai/cordis';

/** ui-sidebar-right 的 Tab 注册表服务（局部投影） */
export interface TabRegistryLike {
  register(definition: {
    id: string;
    kind: string;
    title: (address: string) => string;
    guide?: ReadonlyArray<{
      id: string;
      order: number;
      title: () => string;
      description: () => string;
      icon: unknown;
    }>;
  }): () => void;
}

/** ui-sidebar-right 的导航控制器服务（局部投影） */
export interface SidebarRightLike {
  openTab(kind: string, options?: Record<string, unknown>): unknown;
}

/** ui-slots 的席位系统服务（局部投影） */
export interface SlotsLike {
  inject(slotName: string, register: () => (() => void)): () => void;
  register(spec: Record<string, unknown>, component: unknown): () => void;
}

/** 读取浏览器宿主注入的右侧栏与席位服务。 */
export function readClientHostServices(ctx: Context): {
  tabs?: TabRegistryLike;
  right?: SidebarRightLike;
  slots?: SlotsLike;
} {
  const bag = ctx as unknown as {
    sidebarRightTabs?: TabRegistryLike;
    sidebarRight?: SidebarRightLike;
    slots?: SlotsLike;
  };
  return {
    tabs: bag.sidebarRightTabs,
    right: bag.sidebarRight,
    slots: bag.slots,
  };
}

/** 在浏览器插件 Context 上登记卸载清理函数。 */
export function registerClientEffect(ctx: Context, fn: () => () => void, name?: string): void {
  (ctx as unknown as { effect?(cb: () => () => void, label?: string): void }).effect?.(fn, name);
}
