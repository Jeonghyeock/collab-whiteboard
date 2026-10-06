import { useEffect, useState } from 'react';
import { ArrowRight, Undo2, Users, WifiOff, X } from 'lucide-react';
import { BrandMark } from './board/BrandMark.tsx';
import { randomId } from './lib/id.ts';
import { navigate } from './lib/router.ts';
import { forgetBoard, recentBoards } from './lib/storage.ts';

const relative = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' });

function timeAgo(timestamp: number): string {
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

const FEATURES = [
  { Icon: Users, title: '실시간 협업', text: '다른 사람의 커서와 선택이 그대로 보여요.' },
  { Icon: WifiOff, title: '끊겨도 괜찮아요', text: '오프라인에서 그린 것도 다시 연결되면 자동으로 합쳐져요.' },
  { Icon: Undo2, title: '내 작업만 실행 취소', text: '되돌리기는 내가 바꾼 것만 되돌려요.' },
];

export function Home() {
  const [recent, setRecent] = useState(recentBoards);

  useEffect(() => {
    document.title = 'Whiteboard · 같이 그리는 화이트보드';
  }, []);

  return (
    <main className="home">
      <section className="home-hero">
        <BrandMark size={56} />
        <h1>링크 하나로 같이 그리는 화이트보드</h1>
        <p>로그인도 설치도 없이, 링크를 받은 사람과 바로 함께 그려요.</p>
        <button type="button" className="button primary large" onClick={() => navigate(`/r/${randomId(10)}`)}>
          새 보드 만들기
          <ArrowRight size={18} />
        </button>
      </section>

      {recent.length > 0 && (
        <section className="home-recent">
          <h2>최근에 연 보드</h2>
          <ul>
            {recent.map((board) => (
              <li key={board.id}>
                <a
                  href={`/r/${board.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/r/${board.id}`);
                  }}
                >
                  <span className="recent-id">{board.id}</span>
                  <span className="recent-time">{timeAgo(board.visitedAt)}</span>
                </a>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="목록에서 지우기"
                  title="목록에서 지우기"
                  onClick={() => {
                    forgetBoard(board.id);
                    setRecent(recentBoards());
                  }}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="home-features">
        {FEATURES.map(({ Icon, title, text }) => (
          <div key={title} className="feature">
            <Icon size={20} />
            <strong>{title}</strong>
            <span>{text}</span>
          </div>
        ))}
      </section>
    </main>
  );
}
