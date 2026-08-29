import { CarrierAdapter } from "./types.js";
import { aldotAdapter } from "./aldot.js";
import { eyesAdapter } from "./eyes.js";
import { freetAdapter } from "./freet.js";
import { tplusAdapter } from "./tplus.js";
import { pindirectAdapter } from "./pindirect.js";
import { mmobileAdapter } from "./mmobile.js";

export const CARRIERS: CarrierAdapter[] = [
  aldotAdapter,
  eyesAdapter,
  freetAdapter,
  tplusAdapter,
  pindirectAdapter,
  mmobileAdapter,
];

export const CARRIERS_BY_ID: Record<string, CarrierAdapter> = Object.fromEntries(
  CARRIERS.map((c) => [c.id, c]),
);

export function getCarrier(id: string): CarrierAdapter {
  const c = CARRIERS_BY_ID[id];
  if (!c) throw new Error(`알 수 없는 통신사: ${id}`);
  return c;
}
