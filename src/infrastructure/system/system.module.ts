import { Global, Module } from '@nestjs/common';
import { CLOCK, ID_GENERATOR } from '../../shared-kernel';
import { SystemClock } from './system-clock';
import { UuidGenerator } from './uuid-generator';

/**
 * Adapters de los puertos genéricos del shared-kernel (tiempo e ids).
 *
 * Es `@Global` porque todo bounded context los necesita y repetir el mismo par
 * de providers en cada módulo solo invita a que uno de ellos acabe con una
 * implementación distinta —y con ella, tests que dependen del reloj real.
 */
@Global()
@Module({
  providers: [
    SystemClock,
    UuidGenerator,
    { provide: CLOCK, useExisting: SystemClock },
    { provide: ID_GENERATOR, useExisting: UuidGenerator },
  ],
  exports: [CLOCK, ID_GENERATOR],
})
export class SystemModule {}
