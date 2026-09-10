/**
 * Datos de demostración.
 *
 * Se ejecuta contra una base ya migrada:
 *
 *     pnpm seed
 *
 * Dos decisiones que explican por qué este fichero es como es:
 *
 * 1. **Los datos entran por los CASOS DE USO, no con `INSERT`s.** Arranca un
 *    contexto de aplicación de Nest y llama a `RegisterOrganization`,
 *    `CreateTicket`, `AddComment` y `ChangeTicketStatus` igual que lo haría un
 *    controller. Así el seed hereda gratis el hasheo argon2id, la numeración
 *    correlativa por tenant (ADR-0017), el rastro de auditoría (ADR-0016), los
 *    eventos en el outbox (ADR-0018) y las transiciones legales (ADR-0015). Un
 *    seed a base de `INSERT`s tendría que reimplementar todo eso, y al primer
 *    cambio de reglas produciría datos que el sistema nunca habría aceptado.
 *
 * 2. **Los usuarios AGENT y VIEWER sí se escriben a mano**, con Prisma dentro de
 *    `withTenant`. No es una preferencia: no existe todavía un caso de uso para
 *    incorporar miembros a una organización — `UserRepository` y
 *    `MembershipRepository` son puertos de solo lectura. Es la carencia conocida
 *    que también deja al frontend sin selector de personas al asignar. Cuando
 *    exista `InviteMember`, este bloque se sustituye por una llamada.
 *
 * Es IDEMPOTENTE: si la organización ya existe, no hace nada y sale con 0, para
 * que `docker compose up` dos veces seguidas no falle.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CLOCK, Clock, ID_GENERATOR, IdGenerator } from './shared-kernel';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { RegisterOrganization } from './modules/iam/application/register-organization.use-case';
import { PASSWORD_HASHER } from './modules/iam/domain/ports/password-hasher';
import type { PasswordHasher } from './modules/iam/domain/ports/password-hasher';
import { Password } from './modules/iam/domain/value-objects/password.vo';
import { PrismaOrganizationRepository } from './modules/iam/infrastructure/persistence/prisma-organization.repository';
import { AddComment } from './modules/ticketing/application/add-comment.use-case';
import { ChangeTicketStatus } from './modules/ticketing/application/change-ticket-status.use-case';
import { CreateTicket } from './modules/ticketing/application/create-ticket.use-case';
import { TenantId, TicketId, UserId } from './modules/ticketing/domain/ids';
import type { TicketPriority } from './modules/ticketing/domain/ticket-status';

const ORGANIZATION_NAME = 'Acme Support';
const ORGANIZATION_SLUG = 'acme-support';

/** Una sola contraseña para los tres: son datos de demo, no de producción. */
const DEMO_PASSWORD = 'demo-password-123';

const ADMIN_EMAIL = 'admin@acme.test';
const AGENT_EMAIL = 'agent@acme.test';
const VIEWER_EMAIL = 'viewer@acme.test';

interface SeedTicket {
  subject: string;
  description: string;
  priority: TicketPriority;
  /** Comentarios a añadir, en orden. `staff` decide quién los firma. */
  comments?: { staff: boolean; body: string }[];
  /** Estado final; se alcanza pasando por las transiciones legales. */
  moveTo?: ('IN_PROGRESS' | 'RESOLVED' | 'CLOSED')[];
}

/**
 * Los tickets cubren a propósito las cuatro prioridades y los cuatro estados: la
 * pantalla de detalle muestra un reloj de SLA por prioridad, y sin variedad la
 * demo enseñaría siempre el mismo caso.
 */
const TICKETS: SeedTicket[] = [
  {
    subject: 'No puedo iniciar sesión desde la app móvil',
    description:
      'Desde la actualización de ayer, la app se queda en la pantalla de carga después de meter la contraseña. En el navegador entro sin problema.',
    priority: 'URGENT',
    comments: [
      {
        staff: true,
        body: '¿Qué versión de la app tenés? Estamos viendo un problema con la 4.2.0 en Android.',
      },
      { staff: false, body: 'La 4.2.0, sí. Android 14.' },
    ],
    moveTo: ['IN_PROGRESS'],
  },
  {
    subject: 'La exportación a CSV se corta en 1000 filas',
    description:
      'Al exportar el informe mensual solo bajan las primeras 1000 filas. El informe tiene 4300.',
    priority: 'HIGH',
    comments: [
      {
        staff: true,
        body: 'Confirmado, hay un límite de paginación en el exportador. Va en el próximo despliegue.',
      },
    ],
    moveTo: ['IN_PROGRESS', 'RESOLVED'],
  },
  {
    subject: 'Pedido de acceso al panel de facturación',
    description:
      'Necesito permisos de lectura sobre facturación para cerrar el trimestre.',
    priority: 'NORMAL',
    comments: [{ staff: true, body: 'Concedido. Probá a recargar la página.' }],
    moveTo: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  },
  {
    subject: 'Los correos de notificación llegan a spam',
    description:
      'Todo lo que manda el sistema aterriza en la carpeta de correo no deseado de Outlook.',
    priority: 'NORMAL',
  },
  {
    subject: 'Sugerencia: atajo de teclado para cerrar tickets',
    description:
      'Cerramos decenas de tickets al día y el botón está al final de la página.',
    priority: 'LOW',
  },
];

async function main(): Promise<void> {
  // `warn` y no el nivel por defecto: el arranque de Nest imprime una línea por
  // módulo y ahogaría la única salida que le importa a quien corre esto.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  try {
    const organizations = app.get(PrismaOrganizationRepository);

    if (await organizations.existsBySlug(ORGANIZATION_SLUG)) {
      console.log(
        `La organización "${ORGANIZATION_SLUG}" ya existe: no hay nada que sembrar.`,
      );
      return;
    }

    const prisma = app.get(PrismaService);
    const hasher = app.get<PasswordHasher>(PASSWORD_HASHER);
    const ids = app.get<IdGenerator>(ID_GENERATOR);
    const clock = app.get<Clock>(CLOCK);

    // --- 1. Organización + ADMIN, por el caso de uso de registro ---
    const registered = await app.get(RegisterOrganization).execute({
      organizationName: ORGANIZATION_NAME,
      email: ADMIN_EMAIL,
      password: DEMO_PASSWORD,
    });
    if (registered.isErr()) {
      throw new Error(
        `No se pudo registrar la organización: ${registered.error.code}`,
      );
    }

    const resolved = await organizations.findIdBySlug(ORGANIZATION_SLUG);
    if (resolved === null) {
      throw new Error(
        'La organización se registró pero no se puede resolver por slug.',
      );
    }
    const tenantId = TenantId(resolved);

    // El id del ADMIN no lo devuelve el registro (devuelve tokens), así que se
    // lee bajo el contexto de tenant recién creado.
    const adminId = await prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.user.findFirstOrThrow({
        where: { tenantId, email: ADMIN_EMAIL },
        select: { id: true },
      });
      return UserId(row.id);
    });

    // --- 2. AGENT y VIEWER, a mano (ver cabecera del fichero) ---
    const password = Password.create(DEMO_PASSWORD);
    if (password.isErr()) {
      throw new Error('La contraseña de demo no cumple la política.');
    }
    const passwordHash = await hasher.hash(password.value);
    const now = clock.now();

    const [agentId, viewerId] = await prisma.withTenant(
      tenantId,
      async (tx) => {
        const created: string[] = [];
        for (const [email, role] of [
          [AGENT_EMAIL, 'AGENT'],
          [VIEWER_EMAIL, 'VIEWER'],
        ] as const) {
          const userId = ids.uuid();
          await tx.user.create({
            data: {
              id: userId,
              tenantId,
              email,
              passwordHash: passwordHash.value,
              createdAt: now,
            },
          });
          await tx.membership.create({
            data: {
              id: ids.uuid(),
              tenantId,
              userId,
              role,
              createdAt: now,
            },
          });
          created.push(userId);
        }
        return created;
      },
    );

    // --- 3. Tickets, comentarios y transiciones, por sus casos de uso ---
    const createTicket = app.get(CreateTicket);
    const addComment = app.get(AddComment);
    const changeStatus = app.get(ChangeTicketStatus);

    for (const spec of TICKETS) {
      // Los abre el VIEWER: es quien hace de solicitante en el modelo de roles.
      const created = await createTicket.execute({
        tenantId,
        actorId: UserId(viewerId),
        subject: spec.subject,
        description: spec.description,
        priority: spec.priority,
      });
      if (created.isErr()) {
        throw new Error(`No se pudo crear el ticket: ${created.error.code}`);
      }
      const ticketId = TicketId(created.value.id);

      for (const comment of spec.comments ?? []) {
        // `actorRole` importa: un comentario del solicitante NO para el reloj de
        // primera respuesta, y uno del equipo sí (ADR-0020).
        const result = await addComment.execute({
          tenantId,
          actorId: comment.staff ? UserId(agentId) : UserId(viewerId),
          actorRole: comment.staff ? 'AGENT' : 'VIEWER',
          ticketId,
          body: comment.body,
        });
        if (result.isErr()) {
          throw new Error(`No se pudo comentar: ${result.error.code}`);
        }
      }

      for (const status of spec.moveTo ?? []) {
        const result = await changeStatus.execute({
          tenantId,
          actorId: adminId,
          ticketId,
          status,
        });
        if (result.isErr()) {
          throw new Error(`No se pudo pasar a ${status}: ${result.error.code}`);
        }
      }
    }

    console.log(
      [
        '',
        `Organización sembrada: ${ORGANIZATION_NAME} (slug: ${ORGANIZATION_SLUG})`,
        `  ${TICKETS.length} tickets con comentarios e historial.`,
        '',
        'Entrar con cualquiera de estos (el slug hace falta para el login):',
        `  ADMIN   ${ADMIN_EMAIL}`,
        `  AGENT   ${AGENT_EMAIL}`,
        `  VIEWER  ${VIEWER_EMAIL}`,
        `  clave   ${DEMO_PASSWORD}`,
        '',
      ].join('\n'),
    );
  } finally {
    await app.close();
  }
}

main()
  .then(() => {
    // Salida explícita: BullMQ deja conexiones a Redis que `app.close()` cierra,
    // pero el proceso puede quedarse vivo por un handle rezagado. En un script
    // de un solo uso es preferible terminar a colgarse en silencio.
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
