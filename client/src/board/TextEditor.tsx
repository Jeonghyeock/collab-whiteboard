import { useEffect, useRef } from 'react';
import { LIMITS } from '../../../shared/limits.ts';
import { FONT_FAMILY, LINE_HEIGHT, textSize, worldToScreen } from './geometry.ts';
import type { Camera, TextEditing } from './types.ts';

const PLACEHOLDER = '텍스트 입력';

// 글자를 쓰는 동안에는 SVG 위에 textarea를 겹쳐 띄운다. 끝나면 텍스트 도형 하나로 저장한다.
export function TextEditor(props: {
  editing: TextEditing;
  camera: Camera;
  onChange: (text: string) => void;
  onFinish: () => void;
}) {
  const { editing, camera } = props;
  const ref = useRef<HTMLTextAreaElement>(null);

  // 캔버스를 누른 직후 브라우저가 포커스를 옮기므로, 한 프레임 뒤에 포커스를 가져온다.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const screen = worldToScreen(camera, editing);
  const size = textSize(editing.text || PLACEHOLDER, editing.fontSize);

  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={editing.text}
      placeholder={PLACEHOLDER}
      maxLength={LIMITS.maxTextLength}
      spellCheck={false}
      style={{
        left: screen.x,
        top: screen.y,
        width: (size.width + editing.fontSize) * camera.zoom,
        height: size.height * camera.zoom,
        fontSize: editing.fontSize * camera.zoom,
        lineHeight: LINE_HEIGHT,
        fontFamily: FONT_FAMILY,
        color: editing.color,
      }}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={props.onFinish}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          props.onFinish();
        }
      }}
    />
  );
}
