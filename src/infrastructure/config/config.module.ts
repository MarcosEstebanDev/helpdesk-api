import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';

/**
 * Global, validated configuration. Inject `ConfigService<Env, true>` anywhere
 * to read strongly-typed config values.
 */
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
})
export class ConfigModule {}
