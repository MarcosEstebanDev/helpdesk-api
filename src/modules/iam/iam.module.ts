import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Login } from './application/login.use-case';
import { Logout } from './application/logout.use-case';
import { RefreshTokens } from './application/refresh-tokens.use-case';
import { RegisterOrganization } from './application/register-organization.use-case';
import { SessionIssuer } from './application/session-issuer';
import { CLOCK, Clock } from './domain/ports/clock';
import { ID_GENERATOR, IdGenerator } from './domain/ports/id-generator';
import {
  MEMBERSHIP_REPOSITORY,
  MembershipRepository,
} from './domain/ports/membership.repository';
import {
  ORGANIZATION_REPOSITORY,
  OrganizationRepository,
} from './domain/ports/organization.repository';
import {
  PASSWORD_HASHER,
  PasswordHasher,
} from './domain/ports/password-hasher';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from './domain/ports/refresh-token.repository';
import { TOKEN_SERVICE, TokenService } from './domain/ports/token.service';
import {
  USER_REPOSITORY,
  UserRepository,
} from './domain/ports/user.repository';
import { AccessTokenVerifier } from './infrastructure/auth/access-token.verifier';
import { JwtAuthGuard } from './infrastructure/auth/jwt-auth.guard';
import { RolesGuard } from './infrastructure/auth/roles.guard';
import { TenantContextMiddleware } from './infrastructure/auth/tenant-context.middleware';
import { Argon2PasswordHasher } from './infrastructure/crypto/argon2-password-hasher';
import { JwtTokenService } from './infrastructure/crypto/jwt-token.service';
import { AuthController } from './infrastructure/http/auth.controller';
import { PrismaMembershipRepository } from './infrastructure/persistence/prisma-membership.repository';
import { PrismaOrganizationRepository } from './infrastructure/persistence/prisma-organization.repository';
import { PrismaRefreshTokenRepository } from './infrastructure/persistence/prisma-refresh-token.repository';
import { PrismaUserRepository } from './infrastructure/persistence/prisma-user.repository';
import { SystemClock } from './infrastructure/system/system-clock';
import { UuidGenerator } from './infrastructure/system/uuid-generator';

/**
 * Composición del bounded context IAM.
 *
 * Dos reglas que este módulo hace cumplir:
 *
 * 1. **Los casos de uso siguen siendo puros.** No llevan `@Injectable()` ni
 *    decoradores de Nest: se construyen con `useFactory`, inyectando los
 *    adapters por el TOKEN del puerto. Por eso los tests unitarios de la fase 2b
 *    corren sin Nest.
 * 2. **Nadie depende de un adapter concreto.** Cambiar Prisma por otra cosa, o
 *    argon2 por bcrypt, se hace solo acá.
 */
@Module({
  imports: [JwtModule.register({})], // los secretos se pasan por llamada
  controllers: [AuthController],
  providers: [
    // --- Adapters (implementaciones concretas) ---
    Argon2PasswordHasher,
    JwtTokenService,
    PrismaOrganizationRepository,
    PrismaUserRepository,
    PrismaMembershipRepository,
    PrismaRefreshTokenRepository,
    AccessTokenVerifier,
    TenantContextMiddleware,
    JwtAuthGuard,
    RolesGuard,
    SystemClock,
    UuidGenerator,

    // --- Puertos -> adapters ---
    { provide: CLOCK, useExisting: SystemClock },
    { provide: ID_GENERATOR, useExisting: UuidGenerator },
    { provide: PASSWORD_HASHER, useExisting: Argon2PasswordHasher },
    { provide: TOKEN_SERVICE, useExisting: JwtTokenService },
    {
      provide: ORGANIZATION_REPOSITORY,
      useExisting: PrismaOrganizationRepository,
    },
    { provide: USER_REPOSITORY, useExisting: PrismaUserRepository },
    { provide: MEMBERSHIP_REPOSITORY, useExisting: PrismaMembershipRepository },
    {
      provide: REFRESH_TOKEN_REPOSITORY,
      useExisting: PrismaRefreshTokenRepository,
    },

    // --- Aplicación (clases puras, construidas a mano) ---
    {
      provide: SessionIssuer,
      inject: [TOKEN_SERVICE, REFRESH_TOKEN_REPOSITORY, ID_GENERATOR, CLOCK],
      useFactory: (
        tokens: TokenService,
        refreshTokens: RefreshTokenRepository,
        ids: IdGenerator,
        clock: Clock,
      ): SessionIssuer => new SessionIssuer(tokens, refreshTokens, ids, clock),
    },
    {
      provide: RegisterOrganization,
      inject: [
        ORGANIZATION_REPOSITORY,
        PASSWORD_HASHER,
        ID_GENERATOR,
        CLOCK,
        SessionIssuer,
      ],
      useFactory: (
        organizations: OrganizationRepository,
        hasher: PasswordHasher,
        ids: IdGenerator,
        clock: Clock,
        sessions: SessionIssuer,
      ): RegisterOrganization =>
        new RegisterOrganization(organizations, hasher, ids, clock, sessions),
    },
    {
      provide: Login,
      inject: [
        ORGANIZATION_REPOSITORY,
        USER_REPOSITORY,
        MEMBERSHIP_REPOSITORY,
        PASSWORD_HASHER,
        SessionIssuer,
      ],
      useFactory: (
        organizations: OrganizationRepository,
        users: UserRepository,
        memberships: MembershipRepository,
        hasher: PasswordHasher,
        sessions: SessionIssuer,
      ): Login =>
        new Login(organizations, users, memberships, hasher, sessions),
    },
    {
      provide: RefreshTokens,
      inject: [
        TOKEN_SERVICE,
        REFRESH_TOKEN_REPOSITORY,
        MEMBERSHIP_REPOSITORY,
        CLOCK,
        SessionIssuer,
      ],
      useFactory: (
        tokens: TokenService,
        refreshTokens: RefreshTokenRepository,
        memberships: MembershipRepository,
        clock: Clock,
        sessions: SessionIssuer,
      ): RefreshTokens =>
        new RefreshTokens(tokens, refreshTokens, memberships, clock, sessions),
    },
    {
      provide: Logout,
      inject: [TOKEN_SERVICE, REFRESH_TOKEN_REPOSITORY, CLOCK],
      useFactory: (
        tokens: TokenService,
        refreshTokens: RefreshTokenRepository,
        clock: Clock,
      ): Logout => new Logout(tokens, refreshTokens, clock),
    },
  ],
  // Otros bounded contexts (tickets, fase 4) necesitan proteger sus rutas.
  exports: [JwtAuthGuard, RolesGuard, TenantContextMiddleware],
})
export class IamModule {}
