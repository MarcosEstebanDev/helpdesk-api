import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { Env } from '../../../../infrastructure/config/env.schema';
import type { TenantContext } from '../../../../infrastructure/tenant/tenant-context';
import { AuthTokens } from '../../application/auth-tokens';
import { Login } from '../../application/login.use-case';
import { Logout } from '../../application/logout.use-case';
import { RefreshTokens } from '../../application/refresh-tokens.use-case';
import { RegisterOrganization } from '../../application/register-organization.use-case';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  AuthResponseDto,
  LoginDto,
  MeResponseDto,
  RegisterOrganizationDto,
} from './dto/auth.dto';
import { toHttpException } from './iam-http.mapper';
import {
  LOGIN_THROTTLE,
  REFRESH_THROTTLE,
  REGISTER_THROTTLE,
} from './throttle.policy';

/** El refresh token nunca toca JavaScript del navegador: solo esta cookie. */
const REFRESH_COOKIE = 'refresh_token';
/** Acotar el path limita a qué endpoints la manda el navegador. */
const REFRESH_COOKIE_PATH = '/auth';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerOrganization: RegisterOrganization,
    private readonly login: Login,
    private readonly refreshTokens: RefreshTokens,
    private readonly logout: Logout,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post('register')
  @Throttle({ default: REGISTER_THROTTLE })
  @ApiOperation({ summary: 'Registra una organización y su usuario ADMIN' })
  @ApiResponse({ status: 201, type: AuthResponseDto })
  @ApiResponse({
    status: 409,
    description: 'El nombre de organización ya existe',
  })
  async register(
    @Body() dto: RegisterOrganizationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const result = await this.registerOrganization.execute(dto);
    if (result.isErr()) throw toHttpException(result.error);
    return this.respondWithSession(result.value, res);
  }

  @Post('login')
  @Throttle({ default: LOGIN_THROTTLE })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inicia sesión en una organización' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Credenciales inválidas' })
  async loginHandler(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const result = await this.login.execute(dto);
    if (result.isErr()) throw toHttpException(result.error);
    return this.respondWithSession(result.value, res);
  }

  @Post('refresh')
  @Throttle({ default: REFRESH_THROTTLE })
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({ summary: 'Rota el refresh token y emite un access nuevo' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const token = this.readRefreshCookie(req);
    if (token === null) {
      throw new UnauthorizedException('Falta el refresh token.');
    }

    const result = await this.refreshTokens.execute({ refreshToken: token });
    if (result.isErr()) {
      // Ante reuse o token inválido, borrar la cookie: la sesión ya no sirve y
      // dejarla puesta solo produce reintentos que vuelven a fallar.
      this.clearRefreshCookie(res);
      throw toHttpException(result.error);
    }
    return this.respondWithSession(result.value, res);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoca la familia de refresh tokens (idempotente)',
  })
  async logoutHandler(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = this.readRefreshCookie(req);
    if (token !== null) {
      await this.logout.execute({ refreshToken: token });
    }
    this.clearRefreshCookie(res);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Devuelve el principal autenticado' })
  @ApiResponse({ status: 200, type: MeResponseDto })
  me(@CurrentUser() user: TenantContext): MeResponseDto {
    return { userId: user.userId, tenantId: user.tenantId, role: user.role };
  }

  // ---------------------------------------------------------------------------

  private respondWithSession(
    tokens: AuthTokens,
    res: Response,
  ): AuthResponseDto {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true, // inaccesible desde JS: mitiga XSS
      sameSite: 'lax', // mitiga CSRF sin romper la navegación normal
      secure: this.isProduction(), // en local no hay HTTPS
      path: REFRESH_COOKIE_PATH,
      expires: tokens.refreshTokenExpiresAt,
    });
    return { accessToken: tokens.accessToken };
  }

  private readRefreshCookie(req: Request): string | null {
    const raw: unknown = req.cookies?.[REFRESH_COOKIE];
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  }

  private isProduction(): boolean {
    return this.config.get('NODE_ENV', { infer: true }) === 'production';
  }
}
