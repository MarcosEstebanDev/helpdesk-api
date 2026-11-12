import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { CreateTag } from '../../application/tags/create-tag.use-case';
import { DeleteTag } from '../../application/tags/delete-tag.use-case';
import { ListTags } from '../../application/tags/list-tags.use-case';
import { UpdateTag } from '../../application/tags/update-tag.use-case';
import { DuplicateTagNameError, TicketingError } from '../../domain/errors';
import { TagId, TenantId, UserId } from '../../domain/ids';
import { Tag } from '../../domain/tag/tag.entity';
import { CreateTagDto, TagDto, TagListDto, UpdateTagDto } from './dto/tag.dto';
import { toHttpException } from './ticketing-http.mapper';

export const toTagDto = (t: Tag): TagDto => ({
  id: t.id,
  name: t.name,
  color: t.color,
});

/**
 * Catálogo de etiquetas (ADR-0031).
 *
 * Leer y crear pide AGENT: el agente crea etiquetas al vuelo mientras trabaja.
 * Renombrar, recolorear y borrar pide ADMIN, porque afecta a todos los tickets
 * que la usan. El VIEWER no ve nada: es clasificación interna del equipo.
 */
@ApiTags('tags')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tags')
export class TagController {
  constructor(
    private readonly listTags: ListTags,
    private readonly createTag: CreateTag,
    private readonly updateTag: UpdateTag,
    private readonly deleteTag: DeleteTag,
  ) {}

  @Get()
  @MinRole('AGENT')
  @ApiOperation({ summary: 'Etiquetas de la organización, por nombre' })
  @ApiResponse({ status: 200, type: TagListDto })
  async list(@CurrentUser() user: TenantContext): Promise<TagListDto> {
    const todas = await this.listTags.execute({
      tenantId: TenantId(user.tenantId),
    });
    return { items: todas.map(toTagDto) };
  }

  @Post()
  @MinRole('AGENT')
  @ApiOperation({ summary: 'Crea una etiqueta' })
  @ApiResponse({ status: 201, type: TagDto })
  async create(
    @CurrentUser() user: TenantContext,
    @Body() dto: CreateTagDto,
  ): Promise<TagDto> {
    const result = await conflictoComoDuplicado(() =>
      this.createTag.execute({
        tenantId: TenantId(user.tenantId),
        actorId: UserId(user.userId),
        name: dto.name,
        color: dto.color,
      }),
    );
    if (result.isErr()) throw toHttpException(result.error);
    return toTagDto(result.value);
  }

  @Patch(':id')
  @MinRole('ADMIN')
  @ApiOperation({ summary: 'Renombra o cambia el color de una etiqueta' })
  @ApiResponse({ status: 200, type: TagDto })
  async update(
    @CurrentUser() user: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTagDto,
  ): Promise<TagDto> {
    const result = await conflictoComoDuplicado(() =>
      this.updateTag.execute({
        tenantId: TenantId(user.tenantId),
        actorId: UserId(user.userId),
        id: TagId(id),
        name: dto.name,
        color: dto.color,
      }),
    );
    if (result.isErr()) throw toHttpException(result.error);
    return toTagDto(result.value);
  }

  @Delete(':id')
  @MinRole('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Borra una etiqueta y la quita de todos los tickets',
  })
  @ApiResponse({ status: 204 })
  async remove(
    @CurrentUser() user: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const result = await this.deleteTag.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      id: TagId(id),
    });
    if (result.isErr()) throw toHttpException(result.error);
  }
}

/**
 * Dos personas creando la misma etiqueta a la vez llegan las dos a la
 * restricción única (P2002): se responde el mismo 409 que el caso normal.
 */
async function conflictoComoDuplicado<T>(
  fn: () => Promise<Result<T, TicketingError>>,
): Promise<Result<T, TicketingError>> {
  try {
    return await fn();
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      throw toHttpException(new DuplicateTagNameError());
    }
    throw e;
  }
}
