const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// crypto.randomUUID()는 https/localhost에서만 동작한다. 사내망 IP(http)로 접속해도 되도록 getRandomValues를 쓴다.
export function randomId(length = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = '';
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}
