import type { DayFilter, Hours } from "@/lib/availability";
import type { Interval } from "@/lib/intervals";
import type { ClientSettings, Person, Zone } from "@/lib/types";
import type { GridSelection } from "./time-grid";

export type ViewName = "day" | "week" | "month" | "schedule" | "status";

export type AppState = {
  view: ViewName;
  date: string;
  /** Ticked people; null = everyone. */
  people: string[] | null;
  hours: Hours;
  min: number;
  duration: number;
  ahead: number;
  dayFilter: DayFilter;
  /** Times outside working hours can be picked and searched. */
  offHours: boolean;
};

export type ViewProps = {
  settings: ClientSettings;
  /** The viewer's zone; every time on screen is in it. */
  tz: string;
  /** Configured zones plus the viewer's, for showing times side by side. */
  zones: Zone[];
  /** Where free time is looked for on a day (search hours ∩ working hours). */
  windowsFor: (day: string) => Interval[];
  /** Parts of a day that can be selected; null = all of it. */
  selectableFor: (day: string) => Interval[] | null;
  state: AppState;
  update: (patch: Partial<AppState>) => void;
  /** Ticked people, in the order they signed up. */
  people: Person[];
  refreshKey: number;
  now: number;
  selection: GridSelection | null;
  setSelection: (s: GridSelection | null) => void;
  /** Open the invite dialog for a free range on a day. */
  onInvite: (day: string, range: Interval) => void;
};
