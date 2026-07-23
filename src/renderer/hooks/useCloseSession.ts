/**
 * @file src/renderer/hooks/useCloseSession.ts
 * @purpose 关闭终端的统一入口,带「自动续看」:关掉当前正在看的终端时,
 *   若同目录有无主(orphan)的终端,接管它作为下一个显示目标,而不是掉进
 *   EmptyPathState。
 *
 * @为什么需要:
 * - 一个窗口同一时刻只持有 1 个 session(SessionManager.createSession /
 *   claimOwner 都会 releaseAllOwnedBy)。关掉当前终端后,本窗口就不再持有
 *   任何 session,getDisplayableSession 返回 null → 主区掉进「新建终端」页。
 * - 即便标签栏可见(还能点别的 tab),「关一个却看到新建页」仍违反「关一个、
 *   看下一个」的直觉;隐藏标签栏时更痛。所以续看逻辑对所有关闭路径通用,
 *   不看标签栏藏没藏。
 * - 「他人窗口持有」的 session 不能接管(只能 focus-owner),故不作为候选。
 *
 * @两套入口(同一份逻辑):
 * - useCloseSession() hook:给已经订阅 useAppState 的组件(MainPane 的 Tab /
 *   hideTopTabBar 工具栏)。拿到的 state 是响应式最新的。
 * - closeSessionWithContinue(state, dispatch, sessionId) 纯函数:给刻意不订阅
 *   useAppState、用 stateRef 防抖动的组件(Sidebar 的 SessionItem)。调时传
 *   stateRef.current。
 *
 * @时序要点(避免中间闪一下 EmptyPathState):
 * 先乐观 dispatch 选中候选(owner-changed + select-session),再发起 SESSION_CLOSE。
 * 这样随后到达的 sessions/destroyed(被关的那个)不会命中 selectedSessionId
 * (已切到候选)。SESSION_CLAIM 失败(候选被别的窗口抢先接管)时回滚到
 * EmptyPathState —— 与「没有候选」的兜底一致。
 *
 * @对应文档: 软件定义书 8.3/8.4(session owner / orphan 接管)。
 */
import { useCallback, type Dispatch } from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import {
  type AppAction,
  type AppState,
  findPathNode,
  getDisplayableSession,
  useAppDispatch,
  useAppState,
} from '../store';

/**
 * 关闭 session 的核心逻辑(带自动续看)。纯函数,不订阅 store —— 调用方传当前
 * state(响应式或 stateRef.current 均可)+ dispatch。返回 promise,失败仅打日志
 * 不抛(关闭是 fire-and-forget 语义,与原各处一致)。
 */
export async function closeSessionWithContinue(
  state: AppState,
  dispatch: Dispatch<AppAction>,
  sessionId: string,
): Promise<void> {
  // 续看只在「关掉的是当前正在看的终端」时才有意义;关别的终端不影响当前显示。
  const current = getDisplayableSession(state);
  const isCurrent = current?.id === sessionId;

  // 同 path 下找一个无主 session 作为续看候选(顺序与侧栏/Tab 一致)。
  const pathId = isCurrent ? current!.pathId : null;
  const node = pathId ? findPathNode(state.pathTree, pathId) : null;
  const candidate = node?.sessionIds
    .map((sid) => state.sessions.get(sid))
    .find((s) => !!s && s.id !== sessionId && s.ownerWindowId === null);

  if (candidate) {
    // 乐观接管 + 选中,抢在 destroyed 事件之前
    dispatch({
      type: 'sessions/owner-changed',
      sessionId: candidate.id,
      ownerWindowId: state.myWindowId,
    });
    dispatch({ type: 'view/select-session', sessionId: candidate.id });
  }
  try {
    await window.api.invoke(COMMAND_CHANNELS.SESSION_CLOSE, { sessionId });
    if (candidate) {
      // 当前 session 已关,本窗口已无持有;claim 候选(幂等,乐观已设 owner)。
      await window.api
        .invoke(COMMAND_CHANNELS.SESSION_CLAIM, { sessionId: candidate.id })
        .catch((err) => {
          console.error('[useCloseSession] claim-after-close failed, rollback', err);
          dispatch({
            type: 'sessions/owner-changed',
            sessionId: candidate.id,
            ownerWindowId: null,
          });
          dispatch({ type: 'view/select-session', sessionId: null });
        });
    }
  } catch (err) {
    console.error('[useCloseSession] close session failed', err);
    // close 失败:回滚乐观的接管(候选还给别人/变回 orphan),选回被关的那个。
    if (candidate) {
      dispatch({
        type: 'sessions/owner-changed',
        sessionId: candidate.id,
        ownerWindowId: null,
      });
      dispatch({ type: 'view/select-session', sessionId });
    }
  }
}

/**
 * Hook 版:给已订阅 useAppState 的组件(MainPane Tab / 工具栏)。返回一个
 * closeSession(sessionId) 回调,内部拿响应式最新 state。
 */
export function useCloseSession(): (sessionId: string) => Promise<void> {
  const state = useAppState();
  const dispatch = useAppDispatch();
  return useCallback(
    (sessionId: string) => closeSessionWithContinue(state, dispatch, sessionId),
    [state, dispatch],
  );
}
