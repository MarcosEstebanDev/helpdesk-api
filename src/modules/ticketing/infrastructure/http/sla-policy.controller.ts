import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { TenantContext } from '../../../../infrastructure/tenant/tenant-context';
import { CurrentUser } from '../../../iam/infrastructure/auth/current-user.decorator';
import { JwtAuthGuard } from '../../../iam/infrastructure/auth/jwt-auth.guard';
import { MinRole } from '../../../iam/infrastructure/auth/min-role.decorator';
import { GetSlaPolicy } from '../../application/sla/get-sla-policy.use-case';
import { ResetSlaPolicy } from '../../application/sla/reset-sla-policy.use-case';
import { UpdateSlaPolicy } from '../../application/sla/update-sla-policy.use-case';
import { TenantId, UserId } from '../../domain/ids';
import {
  TICKET_PRIORITIES,
  TicketPriority,
  isTicketPriority,
} from '../../domain/ticket-status';
import {
  EffectiveSlaTargetDto,
  UpdateSlaPolicyDto,
} from './dto/sla-policy.dto';
import { toHttpException } from './ticketing-http.mapper';

/**
 * Configuración del SLA de la organización (ADR-0020).
 *
 * **Todo pide `ADMIN`, incluida la lectura.** Es la excepción a la regla del
 * resto del módulo, donde leer es cosa de `VIEWER`: aquí no se está mirando un
 * ticket, se está mirando lo que la organización se ha comprometido a cumplir.
 * Un usuario final que ve "resolución garantizada en 4 horas" tiene en la mano
 * un argumento contractual que nadie le prometió por este canal.
 *
 * El recurso se direcciona por PRIORIDAD y no por un id: es una tabla de cuatro
 * filas conceptuales que siempre existen —aunque no haya nada en la base de
 * datos, porque los valores por defecto viven en el dominio—, así que `PUT` es
 * el verbo correcto y `DELETE` significa "vuelve al valor de fábrica", no
 * "deja de existir".
 */
@ApiTags('sla')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('sla-policy')
export class SlaPolicyController {
  constructor(
    private readonly getPolicy: GetSlaPolicy,
    private readonly updatePolicy: UpdateSlaPolicy,
    private readonly resetPolicy: ResetSlaPolicy,
  ) {}

  @Get()
  @MinRole('ADMIN')
  @ApiOperation({ summary: 'Política de SLA vigente, prioridad a prioridad' })
  @ApiResponse({ status: 200, type: [EffectiveSlaTargetDto] })
  async current(
    @CurrentUser() user: TenantContext,
  ): Promise<EffectiveSlaTargetDto[]> {
    return this.getPolicy.execute({ tenantId: TenantId(user.tenantId) });
  }

  @Put(':priority')
  @MinRole('ADMIN')
  @ApiOperation({ summary: 'Fija el objetivo de SLA de una prioridad' })
  @ApiParam({ name: 'priority', enum: TICKET_PRIORITIES })
  @ApiResponse({ status: 200, type: [EffectiveSlaTargetDto] })
  async update(
    @CurrentUser() user: TenantContext,
    @Param('priority') priority: string,
    @Body() dto: UpdateSlaPolicyDto,
  ): Promise<EffectiveSlaTargetDto[]> {
    const result = await this.updatePolicy.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      priority: this.parsePriority(priority),
      responseMinutes: dto.responseMinutes,
      resolutionMinutes: dto.resolutionMinutes,
    });
    if (result.isErr()) throw toHttpException(result.error);
    return result.value;
  }

  @Delete(':priority')
  @MinRole('ADMIN')
  @ApiOperation({
    summary: 'Devuelve una prioridad al objetivo por defecto del producto',
  })
  @ApiParam({ name: 'priority', enum: TICKET_PRIORITIES })
  @ApiResponse({ status: 200, type: [EffectiveSlaTargetDto] })
  async reset(
    @CurrentUser() user: TenantContext,
    @Param('priority') priority: string,
  ): Promise<EffectiveSlaTargetDto[]> {
    // Devuelve 200 con la política resultante, no 204: quien acaba de resetear
    // quiere ver a qué valor ha vuelto, y esa cifra está en el dominio, no en
    // ningún sitio que el cliente pueda consultar sin otra llamada.
    return this.resetPolicy.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      priority: this.parsePriority(priority),
    });
  }

  /**
   * Valida el segmento de la URL con el guard del DOMINIO en vez de con
   * `ParseEnumPipe`: así la lista de prioridades válidas tiene un solo dueño y
   * añadir una mañana no exige acordarse de este fichero.
   */
  private parsePriority(value: string): TicketPriority {
    if (!isTicketPriority(value)) {
      throw new BadRequestException(
        `Prioridad desconocida: "${value}". Válidas: ${TICKET_PRIORITIES.join(', ')}.`,
      );
    }
    return value;
  }
}
