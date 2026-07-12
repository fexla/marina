/**
 * @file SkillInstallDialog.tsx
 * @purpose 让用户选择将 Marina 内置 show-in-marina skill 安装到当前收藏项目的
 *   Pi、Claude Code、Codex 项目级目录。
 *
 * @关键设计:
 * - 只由本地收藏路径的右键菜单打开；SSH 路径没有本机文件系统语义，不能安装。
 * - 先以 overwrite=false 预检，发现已有同名 skill 时用现有 Modal 二次确认，
 *   防止无提示覆盖项目文件。
 * - 后端是当前 backend：远程 backend 窗口会让 daemon 在远程项目上安装，而不是
 *   错把路径写到客户端机器。
 */
import { useEffect, useRef, useState } from 'react';
import { COMMAND_CHANNELS, type InstallMarinaSkillResponse } from '@shared/protocol';
import { useModal } from './Modal';

const TARGETS = [
  { id: 'pi', title: 'Pi', path: '.pi/skills/show-in-marina' },
  { id: 'claude', title: 'Claude Code', path: '.claude/skills/show-in-marina' },
  { id: 'codex', title: 'Codex', path: '.agents/skills/show-in-marina' },
] as const;
type TargetId = (typeof TARGETS)[number]['id'];

interface SkillInstallDialogProps {
  projectPath: string;
  projectName: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

export function SkillInstallDialog({
  projectPath,
  projectName,
  onClose,
  onSuccess,
  onError,
}: SkillInstallDialogProps): JSX.Element {
  const modal = useModal();
  const [selected, setSelected] = useState<Set<TargetId>>(() => new Set(['pi', 'claude', 'codex']));
  const [installing, setInstalling] = useState(false);
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => firstInputRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' && !installing) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [installing, onClose]);

  const toggleTarget = (target: TargetId): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  };

  const install = async (overwrite: boolean): Promise<void> => {
    const targets = [...selected];
    if (targets.length === 0) {
      onError('请至少选择一个目标工具。');
      return;
    }
    setInstalling(true);
    try {
      const result = await window.api.invoke<
        { projectPath: string; targets: TargetId[]; overwrite: boolean },
        InstallMarinaSkillResponse
      >(COMMAND_CHANNELS.SKILL_INSTALL_MARINA, { projectPath, targets, overwrite });
      if (result.conflicts.length > 0 && !overwrite) {
        const preview = result.conflicts
          .map((conflict) => `${conflict.target}: ${conflict.destination}`)
          .join('\n');
        const confirmed = await modal.confirm({
          title: 'Skill 已存在',
          message: '以下项目目录已有同名 show-in-marina skill。覆盖会替换整个 skill 目录。',
          preview,
          confirmLabel: '覆盖安装',
          cancelLabel: '取消',
          danger: true,
        });
        if (confirmed) await install(true);
        return;
      }
      onSuccess(
        `已为 ${result.installed.map((item) => item.target).join('、')} 安装 show-in-marina skill`,
      );
      onClose();
    } catch (err) {
      onError(`安装 Skill 失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="app-modal-backdrop" role="presentation">
      <div
        className="app-modal-panel skill-install-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-install-title"
      >
        <div id="skill-install-title" className="app-modal-title">
          安装 Marina Skill
        </div>
        <div className="app-modal-message">
          将内置 <code>show-in-marina</code> 安装到收藏项目“{projectName}”的对应 agent 目录。
        </div>
        <div className="skill-install-options">
          {TARGETS.map((target, index) => (
            <label key={target.id} className="skill-install-option">
              <input
                ref={index === 0 ? firstInputRef : undefined}
                type="checkbox"
                checked={selected.has(target.id)}
                disabled={installing}
                onChange={() => toggleTarget(target.id)}
              />
              <span>
                <strong>{target.title}</strong>
                <code>{target.path}</code>
              </span>
            </label>
          ))}
        </div>
        <div className="app-modal-actions">
          <button
            type="button"
            className="app-modal-button"
            disabled={installing}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="app-modal-button app-modal-button-primary"
            disabled={installing || selected.size === 0}
            onClick={() => void install(false)}
          >
            {installing ? '安装中…' : '安装'}
          </button>
        </div>
      </div>
    </div>
  );
}
