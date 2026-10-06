import { useEffect, useMemo, useState } from 'react';
import type { User } from '../../../shared/protocol.ts';
import { loadUser, rememberBoard, saveUser } from '../lib/storage.ts';
import { History } from '../sync/History.ts';
import { SyncClient } from '../sync/SyncClient.ts';
import { Board } from './Board.tsx';

const socketUrl = () => `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

// 보드 하나에 연결 하나. 보드를 떠나면 연결을 닫는다.
export function BoardPage({ roomId }: { roomId: string }) {
  const [user, setUser] = useState<User>(loadUser);
  const [client, setClient] = useState<SyncClient | null>(null);

  useEffect(() => {
    rememberBoard(roomId);
    document.title = `${roomId} · Whiteboard`;
    const next = new SyncClient({ url: socketUrl(), roomId, user: loadUser() });
    setClient(next);
    return () => next.close();
  }, [roomId]);

  const history = useMemo(
    () => (client ? new History(() => client.getState().shapes, (ops) => client.mutate(ops)) : null),
    [client],
  );

  function rename(name: string) {
    const next = { ...user, name };
    setUser(next);
    saveUser(next);
    client?.setPresence({ user: next });
  }

  if (!client || !history) return null;
  return <Board roomId={roomId} client={client} history={history} user={user} onRename={rename} />;
}
