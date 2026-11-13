import { TenantId } from '../ids';
import {
  BusinessCalendarConfig,
  BusinessWeek,
  CalendarException,
} from '../sla/business-calendar';

export type CalendarMode = '24_7' | 'business_hours';

export interface StoredCalendarException extends CalendarException {
  id: string;
}

/** Lo que una organización tiene guardado, ya completado con los defaults. */
export interface StoredBusinessCalendar {
  /** Lo que usa el SLA: en `24_7`, sin semana ni excepciones. */
  config: BusinessCalendarConfig;
  /** `default` = nunca se configuró (rige `DEFAULT_BUSINESS_HOURS`). */
  source: 'default' | 'organization';
  mode: CalendarMode;
  /** La semana tipo se conserva aunque el modo sea 24/7. */
  week: BusinessWeek;
  /** Ordenadas por fecha. */
  exceptions: StoredCalendarException[];
}

/**
 * Horario laboral de cada organización (ADR-0034). Sin fila, el adapter
 * devuelve los valores por defecto del DOMINIO: no se siembran filas al
 * registrar, igual que con la política de SLA.
 */
export interface BusinessCalendarRepository {
  configOf(tenantId: TenantId): Promise<StoredBusinessCalendar>;
  /** Upsert de la semana tipo y el modo. */
  saveWeek(input: {
    tenantId: TenantId;
    mode: CalendarMode;
    week: BusinessWeek;
    now: Date;
  }): Promise<void>;
  /** `duplicate` si esa fecha ya tiene una excepción (no la pisa). */
  addException(input: {
    tenantId: TenantId;
    id: string;
    exception: CalendarException;
    now: Date;
  }): Promise<'added' | 'duplicate'>;
  /** Alta en bloque que salta las fechas ya cargadas. Devuelve cuántas agregó. */
  addExceptions(input: {
    tenantId: TenantId;
    items: { id: string; exception: CalendarException }[];
    now: Date;
  }): Promise<number>;
  /** `true` si existía y se borró. */
  removeException(tenantId: TenantId, id: string): Promise<boolean>;
}

export const BUSINESS_CALENDAR_REPOSITORY = Symbol(
  'ticketing.BusinessCalendarRepository',
);
