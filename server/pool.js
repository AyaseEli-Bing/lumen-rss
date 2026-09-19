/**
 * 并发调度池
 *
 * 两条约束同时生效：
 *  1) 全局并发上限（保护本机与网络出口）
 *  2) 单域名并发上限（避免对同一个站点狂打请求，多数订阅源被封都是这个原因）
 *
 * 队列采用「按 host 择先」而不是严格 FIFO：当队首任务所属域名已满时，
 * 会跳过它去执行后面域名空闲的任务，从而在保证限速的前提下不牺牲整体吞吐。
 */
export function createPool({ limit = 6, perHost = 2 } = {}) {
  let active = 0;
  const activeByHost = new Map();
  const queue = [];
  const waiters = [];

  const hostCount = (host) => activeByHost.get(host) || 0;

  const canRun = (task) => {
    if (active >= limit) return false;
    if (task.host && hostCount(task.host) >= perHost) return false;
    return true;
  };

  const settleIfIdle = () => {
    if (active === 0 && queue.length === 0) {
      const pending = waiters.splice(0);
      for (const resolve of pending) resolve();
    }
  };

  const pump = () => {
    while (active < limit) {
      const index = queue.findIndex(canRun);
      if (index === -1) break;
      const [task] = queue.splice(index, 1);
      active += 1;
      if (task.host) activeByHost.set(task.host, hostCount(task.host) + 1);

      Promise.resolve()
        .then(task.fn)
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1;
          if (task.host) {
            const next = hostCount(task.host) - 1;
            if (next <= 0) activeByHost.delete(task.host);
            else activeByHost.set(task.host, next);
          }
          pump();
          settleIfIdle();
        });
    }
  };

  return {
    get active() { return active; },
    get pending() { return queue.length; },
    get stats() { return { active, pending: queue.length, limit, perHost }; },

    /** @param {() => Promise<any>} fn @param {string} host */
    run(fn, host = '') {
      return new Promise((resolve, reject) => {
        queue.push({ fn, host, resolve, reject });
        pump();
      });
    },

    /** 等待队列排空（供定时任务在关闭前收敛）。 */
    drain() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    }
  };
}

export function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

/** 把任务数组交给池子并发执行，返回与输入同序的结果（含错误对象，不抛出）。 */
export async function runAll(pool, tasks, metaOf = () => '') {
  return Promise.all(
    tasks.map((task) => pool.run(task, metaOf(task)).catch((err) => ({ __error: err })))
  );
}
