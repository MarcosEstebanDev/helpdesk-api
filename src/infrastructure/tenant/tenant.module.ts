import { Global, Module } from '@nestjs/common';

/**
 * Módulo marcador del contexto de tenant. El contexto en sí vive en un
 * `AsyncLocalStorage` de módulo (no en un provider) porque lo necesitan también
 * los workers de colas, que no tienen inyección de dependencias de Nest.
 */
@Global()
@Module({})
export class TenantModule {}
