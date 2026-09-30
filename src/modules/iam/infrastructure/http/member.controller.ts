import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { TenantContext } from '../../../../infrastructure/tenant/tenant-context';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MinRole } from '../auth/min-role.decorator';
import { TenantId } from '../../domain/ids';
import { MemberReadModel } from '../persistence/member.read-model';
import { MemberListDto } from './dto/member.dto';

/**
 * Directorio de miembros de la organización (ADR-0025).
 *
 * **Por qué el rango mínimo es `AGENT` y no `VIEWER`.** Un VIEWER es el cliente
 * final: alguien que abrió un ticket. Ponerle en la mano el listado completo de
 * empleados sería entregarle una lista de correos cosechable para phishing
 * dirigido —invisible a cualquier defensa anti-scraping, porque el endpoint está
 * autenticado— y una radiografía de la plantilla que ningún cliente necesita.
 * `AGENT` es exactamente el rango que ya puede asignar tickets, así que la
 * audiencia coincide con el propósito sin sobrar nadie.
 *
 * Es el mismo criterio de la Decisión 6 del ADR-0020, que dejó la lectura de la
 * política de SLA en ADMIN aunque leer tickets sea de VIEWER: **el rango se
 * decide por qué información se revela, no por si el verbo es de lectura.**
 *
 * Ojo con lo que este endpoint NO resuelve: mostrar nombres en la conversación
 * de un ticket lo necesita un VIEWER, y la salida para eso es enriquecer
 * `GET /tickets/:id` con los participantes de ESE ticket, no aflojar esto.
 *
 * `JwtAuthGuard` va a nivel de CLASE para que una ruta nueva nazca protegida
 * aunque quien la añada se olvide del decorador.
 */
@ApiTags('members')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('members')
export class MemberController {
  // Lado de lectura inyectado directo (CQRS-lite, ADR-0008): no hay ninguna
  // decisión de negocio que justifique un caso de uso.
  constructor(private readonly members: MemberReadModel) {}

  @Get()
  @MinRole('AGENT')
  @ApiOperation({ summary: 'Lista los miembros de la organización' })
  @ApiResponse({ status: 200, type: MemberListDto })
  async list(@CurrentUser() user: TenantContext): Promise<MemberListDto> {
    // El tenant sale del JWT y de ningún otro sitio. Este endpoint no tiene
    // parámetros de ruta, query ni cuerpo: no existe superficie que manipular.
    const items = await this.members.list(TenantId(user.tenantId));
    return { items };
  }
}
