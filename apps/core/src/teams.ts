/**
 * The teams at CalGames 2026, as the event knows them.
 *
 * From The Blue Alliance's event page for 2026cacg (fetched 2026-10-14) and
 * the event's own pit map and team list: 38 teams. TBA also listed 10615
 * Spartan Tech, which withdrew before the event and is deliberately absent.
 * Public information: every team here is listed on TBA and on the pit map
 * posted in the venue.
 *
 * WHY THE DESK CARRIES ITS OWN TABLE AT ALL
 *
 * Three CalGames entries are SECOND ROBOTS: The Wildhats', Peninsula
 * Robotics' and CardinalBotics' B robots. An offseason registers a second
 * robot under a placeholder number, and these three are 9999, 9998 and 9997.
 * TBA names every one of those "Off-Season Demo Team 9999, Manchester NH",
 * and Cheesy Arena takes its team nicknames from TBA. Left alone, the field
 * would hand the desk that name for The Wildhats' second robot, and every
 * graphic in the building would print it, under the number 9999, which
 * nobody in the stands would recognise as 100B.
 *
 * So for those three the desk overrides BOTH the name and the label shown in
 * place of the number. For everyone else the field's name wins when it has
 * one, and this table is the fallback for a desk running without a field.
 *
 * The NUMBER is never changed. It is the identity everything keys on: the
 * field, the card ledger, robot photos, the schedule. Only what is PRINTED
 * changes.
 *
 * Pits are the event's own codes (Aisle 1 is A and B, Aisle 2 is C and D,
 * Aisle 3 is E and F). Pit F1 on the posted map belonged to 10615, which
 * withdrew, so it is empty.
 */

export interface TeamEntry {
  number: number;
  name: string;
  /** Printed in place of the number. Only for second robots. */
  label?: string;
  /** Pit code, e.g. "A6". */
  pit?: string;
}

export const CALGAMES_2026_TEAMS: TeamEntry[] = [
  { number: 8, name: 'Paly Robotics', pit: 'A1' },
  { number: 100, name: 'The Wildhats', pit: 'A7' },
  { number: 115, name: 'MVRT', pit: 'B7' },
  { number: 253, name: 'The Boba Bots', pit: 'B6' },
  { number: 670, name: 'Homestead Robotics', pit: 'B5' },
  { number: 751, name: 'Barn2Robotics', pit: 'B4' },
  { number: 766, name: 'M-A Bears', pit: 'B3' },
  { number: 840, name: 'Aragon Robotics', pit: 'B2' },
  { number: 841, name: 'The Biomechs', pit: 'B1' },
  { number: 846, name: 'The Funky Monkeys', pit: 'C7' },
  { number: 852, name: 'ARC Robotics', pit: 'C6' },
  { number: 1351, name: 'TKO', pit: 'C5' },
  { number: 1700, name: 'Gatorbotics', pit: 'C4' },
  { number: 1854, name: 'The Chomp Bots', pit: 'C3' },
  { number: 1967, name: 'The Janksters', pit: 'C2' },
  { number: 2473, name: 'Goldstrikers', pit: 'C1' },
  { number: 2643, name: 'Dark Matter', pit: 'D6' },
  { number: 3045, name: 'Gear Gremlins', pit: 'D5' },
  { number: 4159, name: 'CardinalBotics', pit: 'A5' },
  { number: 4765, name: 'PWRUP', pit: 'D4' },
  { number: 4904, name: 'Bot-Provoking', pit: 'D3' },
  { number: 4990, name: 'Basement Bots', pit: 'D2' },
  { number: 5430, name: 'Pirate Robolution', pit: 'D1' },
  { number: 5499, name: 'Bearium', pit: 'E6' },
  { number: 5940, name: 'BREAD', pit: 'E5' },
  { number: 6036, name: 'Peninsula Robotics', pit: 'A3' },
  { number: 6418, name: 'The Missfits', pit: 'E4' },
  { number: 6619, name: 'GravitechX', pit: 'E3' },
  { number: 6884, name: 'Deep Space Robotics', pit: 'E2' },
  { number: 6962, name: 'Antares', pit: 'E1' },
  { number: 7419, name: 'Tech Support', pit: 'F6' },
  { number: 8033, name: 'Highlander Robotics', pit: 'F5' },
  { number: 8404, name: 'SKYWALKERS', pit: 'F4' },
  { number: 9038, name: 'SFUnity', pit: 'F3' },
  { number: 10252, name: 'Mecha Lions', pit: 'F2' },
  // Second robots. The label is what goes on screen instead of the number.
  { number: 9997, name: 'CardinalBotics', label: '4159B', pit: 'A4' },
  { number: 9998, name: 'Peninsula Robotics', label: '6036B', pit: 'A2' },
  { number: 9999, name: 'The Wildhats', label: '100B', pit: 'A6' },
];

let roster = new Map<number, TeamEntry>(CALGAMES_2026_TEAMS.map(t => [t.number, t]));

/** Replace the table, from config.json's teams.list. Bad rows are skipped. */
export function setRoster(list: unknown): void {
  if (!Array.isArray(list)) return;
  const next = new Map<number, TeamEntry>();
  for (const raw of list) {
    const r = raw as Partial<TeamEntry> | null;
    const number = Number(r?.number);
    const name = String(r?.name ?? '').trim();
    if (!Number.isInteger(number) || number <= 0 || !name) continue;
    next.set(number, {
      number, name,
      ...(r?.label ? { label: String(r.label).trim().slice(0, 8) } : {}),
      ...(r?.pit ? { pit: String(r.pit).trim().slice(0, 12) } : {}),
    });
  }
  if (next.size) roster = next;
}

export const teamEntry = (n: number): TeamEntry | undefined => roster.get(n);
export const rosterList = (): TeamEntry[] => [...roster.values()];

/**
 * The name to print for a team.
 *
 * A second robot (an entry with a label) ALWAYS takes the table's name: the
 * field's name for it is TBA's placeholder. Everyone else keeps the field's
 * name when the field has one, because the field is what the scorekeeper
 * corrects on the day.
 */
export function teamName(n: number, fromField?: string | null): string {
  const t = roster.get(n);
  if (t?.label) return t.name;
  const f = String(fromField ?? '').trim();
  return f || t?.name || '';
}
