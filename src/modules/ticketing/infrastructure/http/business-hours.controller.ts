import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { TenantContext } from '../../../../infrastructure/tenant/tenant-context';
import { CurrentUser } from '../../../iam/infrastructure/auth/current-user.decorator';
import { JwtAuthGuard } from '../../../iam/infrastructure/auth/jwt-auth.guard';
import { MinRole } from '../../../iam/infrastructure/auth/min-role.decorator';
import {
  AddCalendarException,
  GetBusinessHours,
  GetBusinessStatus,
  LoadNationalHolidays,
  RemoveCalendarException,
  UpdateBusinessHours,
} from '../../application/business-hours/business-hours.use-cases';
import { TenantId, UserId } from '../../domain/ids';
import {
  AddCalendarExceptionDto,
  BusinessHoursDto,
  BusinessStatusDto,
  CalendarExceptionDto,
  HolidaysLoadedDto,
  UpdateBusinessHoursDto,
} from './dto/business-hours.dto';
import { toHttpException } from './ticketing-http.mapper';

/**
 * Horario laboral de la organización (ADR-0034).
 *
 * Todo es ADMIN —como la política de SLA, de la que es la otra mitad: decide
 * cuándo vence una promesa— salvo `GET /business-hours/status`, que cualquier
 * rol puede pedir y que solo dice si se está atendiendo y cuándo se abre. Es lo
 * que necesita el aviso al cliente, y nada de la configuración interna.
 *
 * Las rutas fijas (`status`, `exceptions`, `holidays`) van declaradas antes que
 * las que llevan parámetro, por la misma razón que `GET /tickets/counts`.
 */
@ApiTags('sla')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('business-hours')
export class BusinessHoursController {
  constructor(
    private readonly getHours: GetBusinessHours,
    private readonly updateHours: UpdateBusinessHours,
    private readonly addException: AddCalendarException,
    private readonly removeException: RemoveCalendarException,
    private readonly loadHolidays: LoadNationalHolidays,
    private readonly getStatus: GetBusinessStatus,
  ) {}

  @Get('status')
  @MinRole('VIEWER')
  @ApiOperation({ summary: 'Si la organización está atendiendo y cuándo abre' })
  @ApiResponse({ status: 200, type: BusinessStatusDto })
  status(@CurrentUser() user: TenantContext): Promise<BusinessStatusDto> {
    return this.getStatus.execute({ tenantId: TenantId(user.tenantId) });
  }

  @Get()
  @MinRole('ADMIN')
  @ApiOperation({
    summary: 'Horario laboral vigente (semana tipo + excepciones)',
  })
  @ApiResponse({ status: 200, type: BusinessHoursDto })
  current(@CurrentUser() user: TenantContext): Promise<BusinessHoursDto> {
    return this.getHours.execute({ tenantId: TenantId(user.tenantId) });
  }

  @Put()
  @MinRole('ADMIN')
  @ApiOperation({ summary: 'Fija la semana tipo y el modo (horario o 24/7)' })
  @ApiResponse({ status: 200, type: BusinessHoursDto })
  async update(
    @CurrentUser() user: TenantContext,
    @Body() dto: UpdateBusinessHoursDto,
  ): Promise<BusinessHoursDto> {
    const r = await this.updateHours.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      ...dto,
    });
    if (r.isErr()) throw toHttpException(r.error);
    return r.value;
  }

  @Post('exceptions')
  @MinRole('ADMIN')
  @ApiOperation({ summary: 'Marca una fecha como no hábil (feriado) o hábil' })
  @ApiResponse({ status: 201, type: CalendarExceptionDto })
  async add(
    @CurrentUser() user: TenantContext,
    @Body() dto: AddCalendarExceptionDto,
  ): Promise<CalendarExceptionDto> {
    const r = await this.addException.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      ...dto,
    });
    if (r.isErr()) throw toHttpException(r.error);
    return r.value;
  }

  @Post('holidays/:year')
  @MinRole('ADMIN')
  @HttpCode(200)
  @ApiOperation({ summary: 'Precarga los feriados nacionales de un año' })
  @ApiResponse({ status: 200, type: HolidaysLoadedDto })
  async holidays(
    @CurrentUser() user: TenantContext,
    @Param('year', ParseIntPipe) year: number,
  ): Promise<HolidaysLoadedDto> {
    const r = await this.loadHolidays.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      year,
    });
    if (r.isErr()) throw toHttpException(r.error);
    return r.value;
  }

  @Delete('exceptions/:id')
  @MinRole('ADMIN')
  @HttpCode(204)
  @ApiOperation({ summary: 'Borra una fecha del horario' })
  async remove(
    @CurrentUser() user: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    const r = await this.removeException.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      id,
    });
    if (r.isErr()) throw toHttpException(r.error);
  }
}
