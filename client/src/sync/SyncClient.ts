import { applyOps, compressOps } from '../../../shared/doc.ts';
import { LIMITS } from '../../../shared/limits.ts';
import type {
  ClientMessage,
  Commit,
  Op,
  Point,
  Presence,
  ServerMessage,
  Shapes,
  User,
} from '../../../shared/protocol.ts';
import { randomId } from '../lib/id.ts';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export type SyncState = {
  status: ConnectionStatus;
  // 서버와 처음 동기화를 마쳤는지. 그 전에는 보드를 그리지 않는다.
  loaded: boolean;
  // 화면에 그릴 상태 = 서버가 확정한 상태 + 아직 확정받지 못한 내 변경
  shapes: Shapes;
  peers: ReadonlyMap<string, Presence>;
  // 서버 확정을 기다리는 내 변경 묶음 수
  pendingCount: number;
};

// clientSeq가 null이면 아직 보내지 않은 묶음이다. 보내지 않은 묶음은 항상 맨 끝에 하나뿐이다.
type PendingMutation = { clientSeq: number | null; ops: Op[] };

export type SyncClientOptions = {
  url: string;
  roomId: string;
  user: User;
  sendIntervalMs?: number;
  heartbeatMs?: number;
};

// 한 메시지에 담을 op의 대략적인 최대 크기. 서버의 메시지 크기 제한보다 넉넉히 작게 잡는다.
const MAX_BATCH_BYTES = 256 * 1024;

export class SyncClient {
  // 페이지를 새로 열 때마다 새로 만든다. 재접속해도 유지되므로 서버가 재전송을 알아볼 수 있다.
  // 서버에만 보내는 비밀 키다. 다른 사람에게는 서버가 이 키로 만든 공개 id만 보인다.
  private readonly clientSecret = randomId(24);
  // welcome에서 받는 내 공개 id. 받은 commit이 내 것인지 알아보는 데 쓴다.
  private clientId: string | null = null;
  private readonly options: SyncClientOptions;
  private readonly sendIntervalMs: number;
  private readonly heartbeatMs: number;

  // 서버가 내 변경을 거부했을 때 호출된다(알림 표시용).
  onReject: ((reason: string) => void) | null = null;

  private ws: WebSocket | null = null;
  private ready = false; // welcome을 받은 뒤부터 true
  private closed = false;
  private networkAvailable = true;

  private confirmed: Shapes = {};
  private seq: number | null = null;
  // seq를 받은 방의 epoch. 재접속할 때 함께 보내, 그사이 서버가 방을 다시 올렸는지 알게 한다.
  private epoch: string | null = null;
  private pending: PendingMutation[] = [];
  private nextClientSeq = 1;

  private state: SyncState = { status: 'connecting', loaded: false, shapes: {}, peers: new Map(), pendingCount: 0 };
  private listeners = new Set<() => void>();

  private retryCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSentAt = 0;
  private lastReceivedAt = 0;

  private user: User;
  private cursor: Point | null = null;
  private selection: string[] = [];
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPresenceAt = 0;

  constructor(options: SyncClientOptions) {
    this.options = options;
    this.user = options.user;
    this.sendIntervalMs = options.sendIntervalMs ?? 50;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleNetworkOnline);
      window.addEventListener('offline', this.handleNetworkOffline);
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.connect();
  }

  // ---- React(useSyncExternalStore)용 ----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  // ---- 변경 ----

  // 화면에는 즉시 반영하고(낙관적 업데이트), 서버에는 sendIntervalMs마다 모아서 보낸다.
  mutate(ops: Op[]): void {
    if (ops.length === 0 || this.closed) return;
    const last = this.pending.at(-1);
    if (last && last.clientSeq === null) {
      last.ops = compressOps([...last.ops, ...ops]);
    } else {
      this.pending.push({ clientSeq: null, ops: compressOps(ops) });
    }
    this.setState({ shapes: applyOps(this.state.shapes, ops), pendingCount: this.pending.length });
    this.scheduleSend();
  }

  setPresence(update: { cursor?: Point | null; selection?: string[]; user?: User }): void {
    if (update.cursor !== undefined) this.cursor = update.cursor;
    if (update.selection !== undefined) this.selection = update.selection.slice(0, LIMITS.maxSelection);
    if (update.user !== undefined) this.user = update.user;
    if (!this.ready || this.presenceTimer) return;
    const delay = Math.max(0, this.lastPresenceAt + this.sendIntervalMs - Date.now());
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.sendPresence();
    }, delay);
  }

  close(): void {
    this.closed = true;
    for (const timer of [this.reconnectTimer, this.sendTimer, this.presenceTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.stopHeartbeat();
    this.detachSocket()?.close(1000, 'client closed');
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleNetworkOnline);
      window.removeEventListener('offline', this.handleNetworkOffline);
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  // ---- 네트워크 상태 (브라우저 이벤트, 테스트에서도 같은 경로를 쓴다) ----

  handleNetworkOffline = () => {
    this.networkAvailable = false;
    this.disconnect();
  };

  handleNetworkOnline = () => {
    this.networkAvailable = true;
    this.reconnectNow();
  };

  private handleVisibilityChange = () => {
    if (document.visibilityState === 'visible' && !this.ws) this.reconnectNow();
  };

  // ---- 연결 ----

  private connect(): void {
    if (this.closed || this.ws || !this.networkAvailable) return;
    this.setState({ status: 'connecting' });
    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    ws.onopen = () => {
      this.lastReceivedAt = Date.now();
      this.send({
        type: 'hello',
        roomId: this.options.roomId,
        clientSecret: this.clientSecret,
        lastSeq: this.seq,
        epoch: this.epoch,
        user: this.user,
      });
      this.startHeartbeat();
    };
    ws.onmessage = (event) => {
      this.lastReceivedAt = Date.now();
      this.handleMessage(JSON.parse(String(event.data)) as ServerMessage);
    };
    ws.onclose = () => this.disconnect();
  }

  // 소켓을 떼어내고 다시 연결을 예약한다. 이미 떼어낸 소켓에서 늦게 오는 이벤트는 무시된다.
  private disconnect(): void {
    const ws = this.detachSocket();
    ws?.close();
    this.ready = false;
    this.stopHeartbeat();
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    this.setState({ status: 'offline', peers: new Map() });
    this.scheduleReconnect();
  }

  private detachSocket(): WebSocket | null {
    const ws = this.ws;
    if (!ws) return null;
    ws.onopen = ws.onmessage = ws.onclose = null;
    this.ws = null;
    return ws;
  }

  // 지수 백오프 + 지터: 서버가 재시작됐을 때 모든 클라이언트가 같은 순간에 몰려들지 않게 한다.
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || !this.networkAvailable) return;
    const base = Math.min(10_000, 500 * 2 ** this.retryCount);
    const delay = base * (0.5 + Math.random() * 0.5);
    this.retryCount += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retryCount = 0;
    this.connect();
  }

  // 브라우저는 WebSocket ping 프레임을 노출하지 않으므로 앱 레벨 ping으로 죽은 연결을 감지한다.
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastReceivedAt > this.heartbeatMs * 2.5) {
        this.disconnect();
        return;
      }
      this.send({ type: 'ping' });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ---- 수신 ----

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        this.clientId = message.clientId;
        this.epoch = message.epoch;
        if (message.sync.kind === 'snapshot') {
          this.confirmed = message.sync.shapes;
          this.seq = message.seq;
        } else {
          for (const commit of message.sync.commits) {
            if (!this.applyCommit(commit)) return;
          }
        }
        // 끊기기 전에 보냈지만 확인을 못 받은 변경 중 서버가 이미 처리한 것은 버린다.
        this.dropAcknowledged(message.lastClientSeq);
        this.ready = true;
        this.retryCount = 0;
        this.setState({
          status: 'online',
          loaded: true,
          peers: new Map(message.peers.map((p) => [p.clientId, p.presence])),
        });
        this.recompute();
        // 남은 변경을 원래 순서와 번호 그대로 다시 보낸다. 서버가 중복은 걸러낸다.
        for (const mutation of this.pending) {
          if (mutation.clientSeq !== null) {
            this.send({ type: 'mutate', clientSeq: mutation.clientSeq, ops: mutation.ops });
          }
        }
        this.flushUnsent();
        this.sendPresence();
        break;
      }
      case 'commit':
        if (this.applyCommit(message.commit)) this.recompute();
        break;
      case 'reject':
        // 서버가 거부한 변경을 대기열에서 빼면, 화면은 서버가 확정한 상태로 돌아간다(롤백).
        this.pending = this.pending.filter((p) => p.clientSeq !== message.clientSeq);
        this.recompute();
        this.onReject?.(message.reason);
        break;
      case 'presence': {
        const peers = new Map(this.state.peers);
        peers.set(message.clientId, message.presence);
        this.setState({ peers });
        break;
      }
      case 'leave': {
        const peers = new Map(this.state.peers);
        peers.delete(message.clientId);
        this.setState({ peers });
        break;
      }
      case 'pong':
        break;
    }
  }

  private applyCommit(commit: Commit): boolean {
    // seq가 하나라도 비면 상태를 믿을 수 없다. 연결을 다시 맺어 스냅샷부터 받는다.
    if (this.seq === null || commit.seq !== this.seq + 1) {
      this.seq = null;
      this.disconnect();
      this.reconnectNow();
      return false;
    }
    this.confirmed = applyOps(this.confirmed, commit.ops);
    this.seq = commit.seq;
    if (commit.clientId === this.clientId) this.dropAcknowledged(commit.clientSeq);
    return true;
  }

  private dropAcknowledged(clientSeq: number): void {
    this.pending = this.pending.filter((p) => p.clientSeq === null || p.clientSeq > clientSeq);
  }

  private recompute(): void {
    let shapes = this.confirmed;
    for (const mutation of this.pending) shapes = applyOps(shapes, mutation.ops);
    this.setState({ shapes, pendingCount: this.pending.length });
  }

  // ---- 송신 ----

  private scheduleSend(): void {
    if (!this.ready || this.sendTimer) return;
    const delay = Math.max(0, this.lastSentAt + this.sendIntervalMs - Date.now());
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.flushUnsent();
    }, delay);
  }

  // 아직 보내지 않은 묶음에 번호를 붙여 보낸다. 너무 크면(오프라인 동안 쌓인 경우 등) 나눠 보낸다.
  private flushUnsent(): void {
    const last = this.pending.at(-1);
    if (!this.ready || !last || last.clientSeq !== null) return;
    this.pending.pop();
    for (const ops of splitOps(last.ops)) {
      const mutation = { clientSeq: this.nextClientSeq++, ops };
      this.pending.push(mutation);
      this.send({ type: 'mutate', clientSeq: mutation.clientSeq, ops });
    }
    this.lastSentAt = Date.now();
    this.setState({ pendingCount: this.pending.length });
  }

  private sendPresence(): void {
    if (!this.ready) return;
    this.lastPresenceAt = Date.now();
    this.send({ type: 'presence', user: this.user, cursor: this.cursor, selection: this.selection });
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private setState(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function splitOps(ops: Op[]): Op[][] {
  const batches: Op[][] = [];
  let current: Op[] = [];
  let bytes = 0;
  for (const op of ops) {
    const size = JSON.stringify(op).length;
    if (current.length > 0 && (current.length >= LIMITS.maxOpsPerMutation || bytes + size > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(op);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
