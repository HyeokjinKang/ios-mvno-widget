import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// 원본 문서(§저장 및 보안)의 "AndroidKeyStore + AES/GCM, Base64(IV) + '.' + Base64(암호문)" 규칙을
// 서버 환경에 맞게 재현. 키는 AndroidKeyStore 대신 MVNO_ENCRYPTION_KEY 환경변수(32바이트 hex)로 관리한다.

function loadKey(): Buffer {
  const raw = process.env.MVNO_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "MVNO_ENCRYPTION_KEY 환경변수가 없습니다. `openssl rand -hex 32` 로 생성해 .env에 넣으세요.",
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("MVNO_ENCRYPTION_KEY는 32바이트(hex 64자)여야 합니다.");
  }
  return key;
}

// iv(12B).authTag(16B).ciphertext 를 각각 base64로 이어 붙인 문자열.
export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string): string {
  const key = loadKey();
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("암호화된 데이터 형식이 잘못됨");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
}
