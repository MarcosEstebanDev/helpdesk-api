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
import { CreateSavedView } from '../../application/saved-views/create-saved-view.use-case';
import { DeleteSavedView } from '../../application/saved-views/delete-saved-view.use-case';
import { ListSavedViews } from '../../application/saved-views/list-saved-views.use-case';
import { UpdateSavedView } from '../../application/saved-views/update-saved-view.use-case';
import {
  DuplicateSavedViewNameError,
  TicketingError,
} from '../../domain/errors';
import { SavedViewId, TenantId, UserId } from '../../domain/ids';
import { SavedView } from '../../domain/saved-view/saved-view.entity';
import {
  CreateSavedViewDto,
  SavedViewDto,
  SavedViewListDto,
  UpdateSavedViewDto,
} from './dto/saved-view.dto';
import { toHttpException } from './ticketing-http.mapper';

const toDto = (v: SavedView): SavedViewDto => ({
  id: v.id,
  name: v.name,
  shared: v.isShared,
  filters: { ...v.filters },
  updatedAt: v.updatedAt.toISOString(),
});

/**
 * Vistas guardadas de la bandeja (ADR-0033). Todo pide AGENT: organizan el
 * trabajo del equipo. Qué puede tocar cada uno (personal del dueño,
 * compartida del ADMIN) lo deciden los casos de uso con el rol del token.
 */
@ApiTags('views')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('views')
export class SavedViewController {
  constructor(
    private readonly listViews: ListSavedViews,
    private readonly createView: CreateSavedView,
    private readonly updateView: UpdateSavedView,
    private readonly deleteView: DeleteSavedView,
  ) {}

  @Get()
  @MinRole('AGENT')
  @ApiOperation({ summary: 'Vistas compartidas y las propias' })
  @ApiResponse({ status: 200, type: SavedViewListDto })
  async list(@CurrentUser() user: TenantContext): Promise<SavedViewListDto> {
    const vistas = await this.listViews.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
    });
    return { items: vistas.map(toDto) };
  }

  @Post()
  @MinRole('AGENT')
  @ApiOperation({ summary: 'Guarda una vista (compartida: solo ADMIN)' })
  @ApiResponse({ status: 201, type: SavedViewDto })
  async create(
    @CurrentUser() user: TenantContext,
    @Body() dto: CreateSavedViewDto,
  ): Promise<SavedViewDto> {
    const result = await duplicadoComoConflicto(() =>
      this.createView.execute({
        tenantId: TenantId(user.tenantId),
        actorId: UserId(user.userId),
        actorRole: user.role,
        name: dto.name,
        filters: dto.filters,
        shared: dto.shared === true,
      }),
    );
    if (result.isErr()) throw toHttpException(result.error);
    return toDto(result.value);
  }

  @Put(':id')
  @MinRole('AGENT')
  @ApiOperation({ summary: 'Reemplaza nombre y filtros' })
  @ApiResponse({ status: 200, type: SavedViewDto })
  async update(
    @CurrentUser() user: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSavedViewDto,
  ): Promise<SavedViewDto> {
    const result = await duplicadoComoConflicto(() =>
      this.updateView.execute({
        tenantId: TenantId(user.tenantId),
        actorId: UserId(user.userId),
        actorRole: user.role,
        id: SavedViewId(id.toLowerCase()),
        name: dto.name,
        filters: dto.filters,
      }),
    );
    if (result.isErr()) throw toHttpException(result.error);
    return toDto(result.value);
  }

  @Delete(':id')
  @MinRole('AGENT')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borra una vista' })
  @ApiResponse({ status: 204 })
  async remove(
    @CurrentUser() user: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const result = await this.deleteView.execute({
      tenantId: TenantId(user.tenantId),
      actorId: UserId(user.userId),
      actorRole: user.role,
      id: SavedViewId(id.toLowerCase()),
    });
    if (result.isErr()) throw toHttpException(result.error);
  }
}

/** Dos personas guardando el mismo nombre a la vez: el mismo 409 (P2002). */
async function duplicadoComoConflicto<T>(
  fn: () => Promise<Result<T, TicketingError>>,
): Promise<Result<T, TicketingError>> {
  try {
    return await fn();
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      throw toHttpException(new DuplicateSavedViewNameError());
    }
    throw e;
  }
}
