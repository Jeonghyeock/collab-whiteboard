import { useState, type FormEvent } from 'react';
import { ImageDown, Link } from 'lucide-react';
import type { Presence, User } from '../../../shared/protocol.ts';
import { navigate } from '../lib/router.ts';
import type { ConnectionStatus } from '../sync/SyncClient.ts';
import { BrandMark } from './BrandMark.tsx';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  online: '실시간 연결됨',
  connecting: '연결 중…',
  offline: '오프라인',
};

// '용감한 수달' → '수'
const initialOf = (name: string) => name.trim().split(/\s+/).at(-1)?.[0]?.toUpperCase() ?? '?';

const MAX_AVATARS = 5;

export function TopBar(props: {
  status: ConnectionStatus;
  pendingCount: number;
  peers: ReadonlyMap<string, Presence>;
  user: User;
  onRename: (name: string) => void;
  onShare: () => void;
  onExport: () => void;
}) {
  const { status, pendingCount, user } = props;
  const [renaming, setRenaming] = useState(false);
  const peers = [...props.peers.entries()];

  return (
    <header className="topbar">
      <div className="panel topbar-group">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
        >
          <BrandMark size={22} />
          <span className="brand-name">Whiteboard</span>
        </a>
        <span className="divider" />
        <span className={`status status-${status}`} role="status">
          <span className="status-dot" />
          {STATUS_LABEL[status]}
          {/* 온라인일 때 잠깐 생기는 전송 중 상태는 깜빡거리기만 하므로 보여주지 않는다. */}
          {status !== 'online' && pendingCount > 0 && <span className="status-pending">· 전송 대기 {pendingCount}</span>}
        </span>
      </div>

      <div className="panel topbar-group">
        <div className="avatars">
          {peers.slice(0, MAX_AVATARS).map(([clientId, { user: peer }]) => (
            <span key={clientId} className="avatar" style={{ background: peer.color }} title={peer.name}>
              {initialOf(peer.name)}
            </span>
          ))}
          {peers.length > MAX_AVATARS && <span className="avatar more">+{peers.length - MAX_AVATARS}</span>}
          <button
            type="button"
            className="avatar me"
            style={{ background: user.color }}
            title={`${user.name} (나) · 눌러서 이름 바꾸기`}
            onClick={() => setRenaming((v) => !v)}
          >
            {initialOf(user.name)}
          </button>
        </div>
        <button type="button" className="button" onClick={props.onExport} title="PNG 이미지로 내보내기">
          <ImageDown size={16} />
          <span className="button-label">내보내기</span>
        </button>
        <button type="button" className="button primary" onClick={props.onShare}>
          <Link size={16} />
          <span className="button-label">링크 복사</span>
        </button>
      </div>

      {renaming && (
        <RenameForm
          name={user.name}
          onSubmit={(name) => {
            props.onRename(name);
            setRenaming(false);
          }}
          onCancel={() => setRenaming(false)}
        />
      )}
    </header>
  );
}

function RenameForm(props: { name: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(props.name);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) props.onSubmit(value.trim());
  };
  return (
    <form className="panel rename" onSubmit={submit}>
      <label htmlFor="rename-input">다른 사람에게 보일 이름</label>
      <div className="rename-row">
        <input
          id="rename-input"
          autoFocus
          value={value}
          maxLength={32}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && props.onCancel()}
        />
        <button type="submit" className="button primary">
          저장
        </button>
      </div>
    </form>
  );
}
