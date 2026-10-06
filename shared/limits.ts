// 클라이언트도 참조하는 값이라 zod 스키마(protocol.ts)와 분리해 둔다. 번들에 zod가 딸려 들어가지 않게 하기 위해서다.
export const LIMITS = {
  maxShapesPerRoom: 5000,
  maxOpsPerMutation: 500,
  maxPenCoords: 8000, // 점 4000개 (x, y 평탄화)
  maxTextLength: 5000,
  maxSelection: 500,
  maxMembersPerRoom: 50,
  maxMessageBytes: 1024 * 1024,
} as const;
