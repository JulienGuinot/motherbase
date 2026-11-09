import { before, GET, POST, PATCH, PUT, DELETE, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { parseInput } from '../../lib/parse-input';
import { IDENTIFIER_RE } from '../../lib/sql-identifier';
import { COLUMN_PRIVILEGES, CONFIG_SCOPES } from '../../services/admin/database-ddl';

/**
 * Supabase Studio's Database section, beyond tables and functions: table
 * sizes, indexes across a schema, enumerated types, roles, column privileges,
 * publications and Postgres settings.
 *
 * Schema objects (`/schema/*`) sit next to the ones `admin-schema` already
 * serves; cluster-level objects live under `/database/*`, which the console
 * proxy rates `settings.write` for writes, and `secrets.manage` for roles
 * because a role can carry a login password.
 */

const identifier = z.string().regex(IDENTIFIER_RE, 'must be a plain SQL identifier');
const schemaQuery = z.object({ schema: identifier.optional() });
// Enum labels are string literals, not identifiers: any text, within Postgres' 63-byte limit.
const enumLabel = z.string().min(1).max(63);
const tableRef = z.object({ schema: identifier.default('public'), table: identifier });
const publishFlags = {
  insert: z.boolean(),
  update: z.boolean(),
  delete: z.boolean(),
  truncate: z.boolean(),
};

const createEnumBody = z.object({ name: identifier, values: z.array(enumLabel).min(1) });
const alterEnumBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add-value'), value: enumLabel, before: enumLabel.optional(), after: enumLabel.optional() }),
  z.object({ action: z.literal('rename-value'), from: enumLabel, to: enumLabel }),
  z.object({ action: z.literal('rename'), name: identifier }),
]);

const roleAttributes = z.object({
  canLogin: z.boolean().optional(),
  isSuperuser: z.boolean().optional(),
  canCreateDb: z.boolean().optional(),
  canCreateRole: z.boolean().optional(),
  canReplicate: z.boolean().optional(),
  canBypassRls: z.boolean().optional(),
  inheritRole: z.boolean().optional(),
  connectionLimit: z.number().int().min(-1).optional(),
  password: z.string().min(1).nullable().optional(),
  validUntil: z.string().datetime({ offset: true }).nullable().optional(),
});
const createRoleBody = roleAttributes.extend({ name: identifier });
const updateRoleBody = roleAttributes.extend({ name: identifier.optional() });

const columnPrivilegesQuery = z.object({ schema: identifier.optional(), table: identifier });
const columnPrivilegeBody = z.object({
  schema: identifier.optional(),
  table: identifier,
  role: identifier,
  privilege: z.enum(COLUMN_PRIVILEGES),
  columns: z.array(identifier).min(1),
  grant: z.boolean(),
});

const createPublicationBody = z.object({
  name: identifier,
  allTables: z.boolean().optional(),
  tables: z.array(tableRef).optional(),
  ...publishFlags,
});
const updatePublicationBody = z.object({
  insert: publishFlags.insert.optional(),
  update: publishFlags.update.optional(),
  delete: publishFlags.delete.optional(),
  truncate: publishFlags.truncate.optional(),
  addTables: z.array(tableRef).optional(),
  dropTables: z.array(tableRef).optional(),
});

const configBody = z.object({
  changes: z.array(z.object({
    name: z.string().min(1),
    // Postgres parses and range-checks the value itself; this only bounds it.
    value: z.string().max(1024).nullable(),
    scope: z.enum(CONFIG_SCOPES).optional(),
    role: identifier.optional(),
  })).min(1),
});

@route('/api/admin')
export default class AdminDatabaseController {
  constructor(private di: IContextContainer) {}

  // ── Tables & indexes ───────────────────────────────────────────────────────

  @GET()
  @route('/schema/table-stats')
  @before(adminOnly)
  async tableStats(req: Request, res: Response, next: NextFunction) {
    try {
      const { schema } = parseInput(schemaQuery, req.query);
      const tables = await this.di.SchemaService.listTableStats(schema);
      return apiResponse.successResponseWithData(res, 'OK', { tables });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/schema/indexes')
  @before(adminOnly)
  async schemaIndexes(req: Request, res: Response, next: NextFunction) {
    try {
      const { schema } = parseInput(schemaQuery, req.query);
      const indexes = await this.di.SchemaService.listSchemaIndexes(schema);
      return apiResponse.successResponseWithData(res, 'OK', { indexes });
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Enumerated types ───────────────────────────────────────────────────────

  @GET()
  @route('/schema/enums')
  @before(adminOnly)
  async listEnums(req: Request, res: Response, next: NextFunction) {
    try {
      const { schema } = parseInput(schemaQuery, req.query);
      const enums = await this.di.EnumTypeService.list(schema);
      return apiResponse.successResponseWithData(res, 'OK', { enums });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/schema/enums')
  @before(adminOnly)
  async createEnum(req: Request, res: Response, next: NextFunction) {
    try {
      const { schema } = parseInput(schemaQuery, req.query);
      const { name, values } = parseInput(createEnumBody, req.body);
      await this.di.EnumTypeService.create(name, values, schema);
      return apiResponse.successResponseWithData(res, 'Created', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/schema/enums/:name')
  @before(adminOnly)
  async alterEnum(req: Request, res: Response, next: NextFunction) {
    try {
      const { schema } = parseInput(schemaQuery, req.query);
      const name = parseInput(identifier, req.params.name);
      const change = parseInput(alterEnumBody, req.body);
      const enums = this.di.EnumTypeService;
      if (change.action === 'add-value') {
        await enums.addValue(name, change.value, { before: change.before, after: change.after }, schema);
      } else if (change.action === 'rename-value') {
        await enums.renameValue(name, change.from, change.to, schema);
      } else {
        await enums.rename(name, change.name, schema);
      }
      return apiResponse.successResponseWithData(res, 'Updated', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/schema/enums/:name')
  @before(adminOnly)
  async dropEnum(req: Request, res: Response, next: NextFunction) {
    try {
      const { schema } = parseInput(schemaQuery, req.query);
      await this.di.EnumTypeService.drop(parseInput(identifier, req.params.name), schema);
      return apiResponse.successResponseWithData(res, 'Dropped', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Roles ──────────────────────────────────────────────────────────────────

  @GET()
  @route('/database/roles')
  @before(adminOnly)
  async listRoles(_req: Request, res: Response, next: NextFunction) {
    try {
      const roles = await this.di.DatabaseRoleService.list();
      return apiResponse.successResponseWithData(res, 'OK', { roles });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/database/roles')
  @before(adminOnly)
  async createRole(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.DatabaseRoleService.create(parseInput(createRoleBody, req.body));
      return apiResponse.successResponseWithData(res, 'Created', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/database/roles/:name')
  @before(adminOnly)
  async updateRole(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.DatabaseRoleService.update(parseInput(identifier, req.params.name), parseInput(updateRoleBody, req.body));
      return apiResponse.successResponseWithData(res, 'Updated', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/database/roles/:name')
  @before(adminOnly)
  async dropRole(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.DatabaseRoleService.drop(parseInput(identifier, req.params.name));
      return apiResponse.successResponseWithData(res, 'Dropped', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Column privileges ──────────────────────────────────────────────────────

  @GET()
  @route('/database/column-privileges')
  @before(adminOnly)
  async columnPrivileges(req: Request, res: Response, next: NextFunction) {
    try {
      const { table, schema } = parseInput(columnPrivilegesQuery, req.query);
      return apiResponse.successResponseWithData(res, 'OK', await this.di.DatabaseRoleService.columnPrivileges(table, schema));
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** Returns the matrix after the change, so the console redraws from the truth. */
  @PUT()
  @route('/database/column-privileges')
  @before(adminOnly)
  async setColumnPrivilege(req: Request, res: Response, next: NextFunction) {
    try {
      const matrix = await this.di.DatabaseRoleService.setColumnPrivilege(parseInput(columnPrivilegeBody, req.body));
      return apiResponse.successResponseWithData(res, 'Updated', matrix);
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Publications ───────────────────────────────────────────────────────────

  @GET()
  @route('/database/publications')
  @before(adminOnly)
  async listPublications(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.PublicationService.list());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/database/publications')
  @before(adminOnly)
  async createPublication(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.PublicationService.create(parseInput(createPublicationBody, req.body));
      return apiResponse.successResponseWithData(res, 'Created', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/database/publications/:name')
  @before(adminOnly)
  async updatePublication(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.PublicationService.update(parseInput(identifier, req.params.name), parseInput(updatePublicationBody, req.body));
      return apiResponse.successResponseWithData(res, 'Updated', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/database/publications/:name')
  @before(adminOnly)
  async dropPublication(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.PublicationService.drop(parseInput(identifier, req.params.name));
      return apiResponse.successResponseWithData(res, 'Dropped', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Postgres settings ──────────────────────────────────────────────────────

  /**
   * Settings plus how to reach the database. The connection block is the
   * password-free subset of `/database/connection`: this route is a plain
   * read, and the credential stays behind `secrets.manage` there.
   */
  @GET()
  @route('/database/config')
  @before(adminOnly)
  async postgresConfig(_req: Request, res: Response, next: NextFunction) {
    try {
      const config = await this.di.PostgresConfigService.get();
      const { password: _password, internalUri: _uri, ...connection } = this.di.DbConnectionService.get();
      // Motherbase ships no pooler: the API pools in-process through Prisma.
      return apiResponse.successResponseWithData(res, 'OK', { ...config, connection: { ...connection, pooler: null } });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/database/config')
  @before(adminOnly)
  async updatePostgresConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const { changes } = parseInput(configBody, req.body);
      return apiResponse.successResponseWithData(res, 'Updated', await this.di.PostgresConfigService.update(changes));
    } catch (error: unknown) {
      return next(error);
    }
  }
}
