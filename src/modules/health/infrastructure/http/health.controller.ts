import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

/**
 * Driving (inbound) adapter. The `health` module is intentionally tiny — it
 * exists in Phase 1 to prove the hexagonal wiring and give CI/containers a
 * liveness probe. Real readiness checks (DB, Redis) arrive in Phase 8.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOkResponse({ description: 'Liveness probe.' })
  check(): { status: 'ok'; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
