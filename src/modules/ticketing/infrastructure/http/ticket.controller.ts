import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { TenantContext } from '../../../../infrastructure/tenant/tenant-context';
import { hasAtLeastRole, isRole } from '../../../iam/domain/role';
import { CurrentUser } from '../../../iam/infrastructure/auth/current-user.decorator';
import { JwtAuthGuard } from '../../../iam/infrastructure/auth/jwt-auth.guard';
import { MinRole } from '../../../iam/infrastructure/auth/min-role.decorator';
import { AddComment } from '../../application/add-comment.use-case';
import { AssignTicket } from '../../application/assign-ticket.use-case';
import { ChangeTicketStatus } from '../../application/change-ticket-status.use-case';
import { CreateTicket } from '../../application/create-ticket.use-case';
import { SetTicketTags } from '../../application/tags/set-ticket-tags.use-case';
import { TagId, TenantId, TicketId, UserId } from '../../domain/ids';
import { SetTicketTagsDto, TicketTagsDto } from './dto/tag.dto';
import { carreraComoErrorDeEtiqueta } from './prisma-races';
import { toTagDto } from './tag.controller';
import {
  AuditEntryDto,
  AddCommentDto,
  AssignTicketDto,
  ChangeTicketStatusDto,
  CreateTicketDto,
  ListTicketsQueryDto,
  TicketCommentDto,
  TicketDetailDto,
  TicketPageDto,
  TicketSummaryDto,
  TicketTriageDto,
} from './dto/ticket.dto';
import { TicketReadModel } from '../persistence/ticket.read-model';
import { toHttpException } from './ticketing-http.mapper';

const DEFAULT_PAGE_SIZE = 20;

/**
 * API de tickets.
 *
 * **Modelo de permisos** (ADR-0014, jerarquía ADMIN > AGENT > VIEWER):
 * - `VIEWER` es el usuario final: lee, abre incidencias y responde en ellas.
 * - `AGENT` además opera la cola: asigna y mueve el estado.
 *
 * Los verbos de escritura sobre el ciclo de vida piden `AGENT` y no `ADMIN`
 * porque atender tickets es el trabajo diario de un agente; reservarlo a los
 * administradores haría el producto inusable.
 *
 * `JwtAuthGuard` se aplica a nivel de CLASE: así una ruta nueva nace protegida
 * aunque quien la añada se olvide del decorador.
 */
@ApiTags('tickets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tickets')
export class TicketController {
  constructor(
    private readonly createTicket: CreateTicket,
    private readonly assignTicket: AssignTicket,
    private readonly changeStatus: ChangeTicketStatus,
    private readonly addComment: AddComment,
    private readonly setTags: SetTicketTags,
    // El lado de lectura se inyecta directo (CQRS-lite, ADR-0008): no pasa por
    // un caso de uso porque no hay ninguna decisión de negocio que tomar.
    private readonly tickets: TicketReadModel,
  ) {}

  @Post()
  @MinRole('VIEWER')
  @ApiOperation({ summary: 'Abre un ticket' })
  @ApiResponse({ status: 201, type: TicketSummaryDto })
  async create(
    @CurrentUser() user: TenantContext,
    @Body() dto: CreateTicketDto,
  ): Promise<TicketSummaryDto> {
    const result = await this.createTicket.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      subject: dto.subject,
      description: dto.description,
      priority: dto.priority ?? 'NORMAL',
    });
    if (result.isErr()) throw toHttpException(result.error);
    return this.toSummary(result.value);
  }

  @Get()
  @MinRole('VIEWER')
  @ApiOperation({
    summary: 'Lista tickets de la organización (paginado por cursor)',
  })
  @ApiResponse({ status: 200, type: TicketPageDto })
  async list(
    @CurrentUser() user: TenantContext,
    @Query() query: ListTicketsQueryDto,
  ): Promise<TicketPageDto> {
    // La sugerencia de la IA es del equipo (ADR-0027): incluye cómo la IA lee al
    // cliente. Un VIEWER no la recibe, y si pide filtrar por ella se le dice que
    // no en vez de ignorar el parámetro en silencio.
    const esEquipo = isRole(user.role) && hasAtLeastRole(user.role, 'AGENT');
    if (query.aiSuggestsHigher === true && !esEquipo) {
      throw new ForbiddenException(
        'Filtrar por la sugerencia de la IA requiere rol AGENT o superior.',
      );
    }
    // Las etiquetas son clasificación interna (ADR-0031): mismo criterio.
    if (query.tagId !== undefined && !esEquipo) {
      throw new ForbiddenException(
        'Filtrar por etiquetas requiere rol AGENT o superior.',
      );
    }
    return this.tickets.list(TenantId(user.tenantId), {
      status: query.status,
      assigneeId: query.assigneeId,
      requesterId: query.requesterId,
      withTriage: esEquipo,
      aiSuggestsHigher: query.aiSuggestsHigher,
      withTags: esEquipo,
      tagIds: query.tagId,
      // Del token verificado: decide si las notas internas cuentan al buscar.
      search:
        query.q === undefined
          ? undefined
          : { text: query.q, viewerRole: user.role },
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
      cursor: query.cursor,
    });
  }

  @Get(':id')
  @MinRole('VIEWER')
  @ApiOperation({ summary: 'Detalle de un ticket con su conversación' })
  @ApiResponse({ status: 200, type: TicketDetailDto })
  async detail(
    @CurrentUser() user: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TicketDetailDto> {
    const ticket = await this.tickets.detail(
      TenantId(user.tenantId),
      TicketId(id),
      // Del token verificado: decide si la conversación trae las notas internas.
      user.role,
    );
    // Un ticket de otra organización es invisible por RLS, así que aquí llega
    // como "no existe" — que es justo lo que queremos responder: un 403 estaría
    // confirmando que ese id existe en algún sitio.
    if (ticket === null) {
      throw new NotFoundException('El ticket no existe.');
    }
    return ticket;
  }

  /**
   * AGENT y no VIEWER, por la regla del ADR-0025: el rango se decide por lo que
   * se revela. La sugerencia incluye el sentimiento que la IA atribuye al
   * cliente, y el cliente es justamente el VIEWER.
   */
  @Get(':id/triage')
  @MinRole('AGENT')
  @ApiOperation({ summary: 'Sugerencia de la IA: categoría y prioridad' })
  @ApiResponse({ status: 200, type: TicketTriageDto })
  async triage(
    @CurrentUser() user: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TicketTriageDto> {
    const view = await this.tickets.triage(
      TenantId(user.tenantId),
      TicketId(id),
    );
    if (view === null) {
      throw new NotFoundException('El ticket no existe.');
    }
    return view;
  }

  @Get(':id/history')
  @MinRole('AGENT')
  @ApiOperation({ summary: 'Rastro de auditoría del ticket' })
  @ApiResponse({ status: 200, type: [AuditEntryDto] })
  async history(
    @CurrentUser() user: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AuditEntryDto[]> {
    return this.tickets.history(TenantId(user.tenantId), TicketId(id));
  }

  @Post(':id/assign')
  @MinRole('AGENT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Asigna el ticket a un miembro de la organización' })
  @ApiResponse({ status: 200, type: TicketSummaryDto })
  @ApiResponse({ status: 409, description: 'El ticket está cerrado' })
  async assign(
    @CurrentUser() user: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignTicketDto,
  ): Promise<TicketSummaryDto> {
    return this.applyAssignment(user, id, UserId(dto.assigneeId));
  }

  @Delete(':id/assign')
  @MinRole('AGENT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Devuelve el ticket a la cola sin asignar' })
  @ApiResponse({ status: 200, type: TicketSummaryDto })
  async unassign(
    @CurrentUser() user: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TicketSummaryDto> {
    return this.applyAssignment(user, id, null);
  }

  @Put(':id/tags')
  @MinRole('AGENT')
  @ApiOperation({ summary: 'Reemplaza las etiquetas del ticket (ADR-0031)' })
  @ApiResponse({ status: 200, type: TicketTagsDto })
  @ApiResponse({ status: 409, description: 'El ticket está cerrado' })
  async putTags(
    @CurrentUser() user: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetTicketTagsDto,
  ): Promise<TicketTagsDto> {
    let result: Awaited<ReturnType<SetTicketTags['execute']>>;
    try {
      result = await this.setTags.execute({
        tenantId: TenantId(user.tenantId),
        actorId: UserId(user.userId),
        ticketId: TicketId(id),
        tagIds: dto.tagIds.map(TagId),
      });
    } catch (e) {
      // Un ADMIN borró una de las etiquetas en el mismo milisegundo (P2003).
      const carrera = carreraComoErrorDeEtiqueta(e);
      if (carrera !== null) throw toHttpException(carrera);
      throw e;
    }
    if (result.isErr()) throw toHttpException(result.error);
    return { tags: result.value.map(toTagDto) };
  }

  @Patch(':id/status')
  @MinRole('AGENT')
  @ApiOperation({ summary: 'Mueve el ticket por su máquina de estados' })
  @ApiResponse({ status: 200, type: TicketSummaryDto })
  @ApiResponse({ status: 409, description: 'Transición no permitida' })
  async patchStatus(
    @CurrentUser() user: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeTicketStatusDto,
  ): Promise<TicketSummaryDto> {
    const result = await this.changeStatus.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      ticketId: TicketId(id),
      status: dto.status,
    });
    if (result.isErr()) throw toHttpException(result.error);
    return this.toSummary(result.value);
  }

  @Post(':id/comments')
  @MinRole('VIEWER')
  @ApiOperation({ summary: 'Añade un comentario al ticket' })
  @ApiResponse({ status: 201, type: TicketCommentDto })
  @ApiResponse({
    status: 403,
    description: 'Un VIEWER no puede escribir notas internas',
  })
  @ApiResponse({ status: 409, description: 'El ticket está cerrado' })
  async comment(
    @CurrentUser() user: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddCommentDto,
  ): Promise<TicketCommentDto> {
    const result = await this.addComment.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      // Del contexto verificado, nunca del cuerpo: si el cliente pudiera decir
      // su propio rol, cumpliría su SLA de respuesta comentándose a sí mismo.
      actorRole: user.role,
      ticketId: TicketId(id),
      body: dto.body,
      visibility: dto.visibility ?? 'PUBLIC',
    });
    if (result.isErr()) throw toHttpException(result.error);

    const comment = result.value;
    return {
      id: comment.id,
      authorId: comment.authorId,
      body: comment.body,
      visibility: comment.visibility,
      createdAt: comment.createdAt,
    };
  }

  // ---------------------------------------------------------------------------

  private async applyAssignment(
    user: TenantContext,
    ticketId: string,
    assigneeId: UserId | null,
  ): Promise<TicketSummaryDto> {
    const result = await this.assignTicket.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      ticketId: TicketId(ticketId),
      assigneeId,
    });
    if (result.isErr()) throw toHttpException(result.error);
    return this.toSummary(result.value);
  }

  private toSummary(ticket: {
    id: string;
    number: number;
    subject: string;
    status: string;
    priority: string;
    requesterId: string;
    assigneeId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): TicketSummaryDto {
    return {
      id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      requesterId: ticket.requesterId,
      assigneeId: ticket.assigneeId,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    };
  }
}
