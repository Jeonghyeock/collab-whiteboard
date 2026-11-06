// 클라이언트도 참조하는 값이라 zod 스키마(protocol.ts)와 분리해 둔다. 번들에 zod가 딸려 들어가지 않게 하기 위해서다.
export const LIMITS = {
  maxShapesPerRoom: 5000,
  maxOpsPerMutation: 500,
  maxPenCoords: 8000, // 점 4000개 (x, y 평탄화)
  maxTextLength: 5000,
  maxSelection: 500,
  maxMembersPerRoom: 50,
  maxMessageBytes: 1024 * 1024,
  maxRoomBytes: 16 * 1024 * 1024, // 방 하나의 도형을 JSON 으로 쓴 크기(어림, server/room.ts)의 상한. 근거는 docs/protocol.md 제한값 절
  maxCoord: 1e6, // 좌표·크기의 절댓값 상한 (protocol.ts 스키마와 클라이언트 clampOps 가 함께 쓴다)
  maxZ: 1e9, // 쌓임 순서(z)의 절댓값 상한
} as const;
