import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { Prisma } from '@prisma/client';
import type { TenantContext } from '../../../../infrastructure/tenant/tenant-context';
import { Result } from '../../../../shared-kernel';
import { CurrentUser } from '../../../iam/infrastructure/auth/current-user.decorator';
import { JwtAuthGuard } from '../../../iam/infrastructure/auth/jwt-auth.guard';
import { MinRole } from '../../../iam/infrastructure/auth/min-role.decorator';
import { CreateCannedResponse } from '../../application/canned-responses/create-canned-response.use-case';
import { DeleteCannedResponse } from '../../application/canned-responses/delete-canned-response.use-case';
import { ListCannedResponses } from '../../application/canned-responses/list-canned-responses.use-case';
import { UpdateCannedResponse } from '../../application/canned-responses/update-canned-response.use-case';
import { CannedResponse } from '../../domain/canned-response/canned-response.entity';
import {
  DuplicateCannedResponseTitleError,
  TicketingError,
} from '../../domain/errors';
import { CannedResponseId, TenantId, UserId } from '../../domain/ids';
import {
  CannedResponseDto,
  CannedResponseInputDto,
  CannedResponseListDto,
} from './dto/canned-response.dto';
import { toHttpException } from './ticketing-http.mapper';

const toDto = (r: CannedResponse): CannedResponseDto => ({
  id: r.id,
  title: r.title,
  body: r.body,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * Respuestas predefinidas de la organización (ADR-0030).
 *
 * **Leer pide AGENT, no VIEWER.** Las plantillas cuentan cómo trabaja el equipo
 * por dentro, y el VIEWER es el cliente final: misma regla que `GET /members`
 * (ADR-0025), el rango se decide por lo que se revela. Escribir pide ADMIN.
 */
@ApiTags('canned-responses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('canned-responses')
export class CannedResponseController {
  constructor(
    private readonly listResponses: ListCannedResponses,
    private readonly createResponse: CreateCannedResponse,
    private readonly updateResponse: UpdateCannedResponse,
    private readonly deleteResponse: DeleteCannedResponse,
  ) {}

  @Get()
  @MinRole('AGENT')
  @ApiOperation({ summary: 'Respuestas predefinidas, por título' })
  @ApiResponse({ status: 200, type: CannedResponseListDto })
  async list(
    @CurrentUser() user: TenantContext,
  ): Promise<CannedResponseListDto> {
    const todas = await this.listResponses.execute({
      tenantId: TenantId(user.tenantId),
    });
    return { items: todas.map(toDto) };
  }

  @Post()
  @MinRole('ADMIN')
  @ApiOperation({ summary: 'Crea una respuesta predefinida' })
  @ApiResponse({ status: 201, type: CannedResponseDto })
  async create(
    @CurrentUser() user: TenantContext,
    @Body() dto: CannedResponseInputDto,
  ): Promise<CannedResponseDto> {
    const result = await this.conflictoComoDuplicado(() =>
      this.createResponse.execute({
        tenantId: TenantId(user.tenantId),
        actorId: UserId(user.userId),
        title: dto.title,
        body: dto.body,
      }),
    );
    if (result.isErr()) throw toHttpException(result.error);
    return toDto(result.value);
  }

  @Put(':id')
  @MinRole('ADMIN')
  @ApiOperation({ summary: 'Reemplaza título y texto' })
  @ApiResponse({ status: 200, type: CannedResponseDto })
  async update(
    @CurrentUser() user: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CannedResponseInputDto,
  ): Promise<CannedResponseDto> {
    const result = await this.conflictoComoDuplicado(() =>
      this.updateResponse.execute({
        tenantId: TenantId(user.tenantId),
        actorId: UserId(user.userId),
        id: CannedResponseId(id),
        title: dto.title,
        body: dto.body,
      }),
    );
    if (result.isErr()) throw toHttpException(result.error);
    return toDto(result.value);
  }

  @Delete(':id')
  @MinRole('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borra una respuesta predefinida' })
  @ApiResponse({ status: 204 })
  async remove(
    @CurrentUser() user: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const result = await this.deleteResponse.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      id: CannedResponseId(id),
    });
    if (result.isErr()) throw toHttpException(result.error);
  }

  /**
   * La comprobación de título del caso de uso cubre el caso normal; dos ADMIN
   * guardando el mismo título a la vez llegan los dos a la restricción única de
   * la base (P2002). Se traduce al MISMO error de dominio, así el cliente ve un
   * único 409 venga de donde venga.
   */
  private async conflictoComoDuplicado<T>(
    fn: () => Promise<Result<T, TicketingError>>,
  ): Promise<Result<T, TicketingError>> {
    try {
      return await fn();
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw toHttpException(new DuplicateCannedResponseTitleError());
      }
      throw e;
    }
  }
}
