import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { RedisHealthIndicator } from './redis.health';

/**
 * Sondas de salud (ADR-0024).
 *
 * **Liveness y readiness son preguntas distintas y por eso son rutas distintas.**
 *
 * - `/health/live` responde "el proceso está vivo" y **no toca ninguna
 *   dependencia**. Si comprobara Postgres, una caída de la base de datos haría
 *   que el orquestador reiniciase la aplicación en bucle: reiniciar no arregla
 *   una base de datos caída, y encima tira las conexiones que quedaban.
 * - `/health/ready` responde "puedo atender tráfico" y sí comprueba Postgres y
 *   Redis. Ahí, fallar es lo correcto: que el balanceador deje de mandar
 *   peticiones a una instancia que no puede servirlas.
 *
 * `GET /health` se mantiene como alias de liveness porque ya estaba publicado
 * desde la fase 1 y hay contenedores apuntando a él.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness (alias histórico de /health/live)' })
  @ApiOkResponse({ description: 'El proceso responde.' })
  check(): { status: 'ok'; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('live')
  @ApiOperation({ summary: '¿El proceso está vivo? No toca dependencias.' })
  @ApiOkResponse({ description: 'El proceso responde.' })
  live(): { status: 'ok'; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: '¿Puede atender tráfico? Comprueba Postgres y Redis.',
  })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.checkPostgres(),
      () => this.redis.ping('redis'),
    ]);
  }

  /**
   * `SELECT 1` a través del cliente de la APLICACIÓN, no de una conexión aparte.
   *
   * Importa: el rol `helpdesk_app` es restringido y no es dueño de las tablas
   * (ADR-0010). Comprobar la salud con otra conexión diría que la base de datos
   * está bien mientras la aplicación sigue sin poder trabajar.
   */
  private async checkPostgres() {
    const indicador = this.indicators.check('postgres');
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return indicador.up();
    } catch (error) {
      return indicador.down({
        message: error instanceof Error ? error.message : 'sin detalle',
      });
    }
  }
}
