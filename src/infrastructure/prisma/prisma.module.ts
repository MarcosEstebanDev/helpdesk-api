import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Acceso a la base de datos, transversal a todos los bounded contexts. Es
 * `@Global` para que cualquier adapter (repos Prisma) inyecte `PrismaService`
 * sin reimportar el módulo en cada feature.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
