import { before, GET, POST, PATCH, DELETE, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { HttpException } from '../../exceptions/http-exception';
import { extractCreatedRelations, tableRoutes } from '../../services/admin/sql.service';
import { parseRlsPolicyPreset } from '../../services/admin/rls.service';
import { generateTypescriptTypes } from '../../services/admin/typegen';
import { INDEX_METHODS } from '../../services/admin/schema.service';
import { parseInput } from '../../lib/parse-input';
import { IDENTIFIER_RE } from '../../lib/sql-identifier';

const identifier = z.string().regex(IDENTIFIER_RE, 'must be a plain SQL identifier');
const createIndexBody = z.object({
  columns: z.array(identifier).min(1),
  unique: z.boolean().default(false),
  method: z.enum(INDEX_METHODS).default('btree'),
  name: identifier.optional(),
  schema: identifier.optional(),
});


@route('/api/admin')
export default class AdminSchemaController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/schema/schemas')
  @before(adminOnly)
  async schemaList(_req: Request, res: Response, next: NextFunction) {
    try {
      const schemas = await this.di.SchemaService.listSchemas();
      return apiResponse.successResponseWithData(res, 'OK', { schemas });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/schema/tables')
  @before(adminOnly)
  async schemaTables(req: Request, res: Response, next: NextFunction) {
    try {
      const tables = await this.di.SchemaService.listTables(req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'OK', { tables });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/schema/graph')
  @before(adminOnly)
  async schemaGraph(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.SchemaService.listGraph(req.query.schema as string | undefined));
    } catch (error: unknown) {
      return next(error);
    }
  }

  /**
   * Type generation source of truth. Returns the STRUCTURED catalog alongside
   * the rendered TypeScript, so the CLI (`motherbase gen types typescript`),
   * the Studio download button and a future MCP `generate_types` tool all read
   * one endpoint and one emitter instead of each growing their own.
   */
  @GET()
  @route('/schema/types')
  @before(adminOnly)
  async schemaTypes(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await generateTypescriptTypes((req.query.schema as string | undefined) ?? 'public');
      return apiResponse.successResponseWithData(res, 'OK', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/schema/tables')
  @before(adminOnly)
  async createTable(req: Request, res: Response, next: NextFunction) {
    try {
      const { sql, policyPreset: rawPolicyPreset } = req.body as { sql: string; policyPreset?: unknown };
      if (!sql?.trim()) throw new HttpException('sql is required', 400);
      const policyPreset = parseRlsPolicyPreset(rawPolicyPreset);

      // REST and the RLS presets both address `public` only. A table created in
      // another schema is still created, but must not be told it has endpoints,
      // and must not have public-schema policies applied to a name that only
      // resolves there by accident of search_path.
      const created = extractCreatedRelations(sql);
      const inPublic = created.filter(relation => !relation.schema || relation.schema === 'public');
      const elsewhere = created.filter(relation => relation.schema && relation.schema !== 'public');
      const newRoutes = inPublic.map(relation => ({ table: relation.name, routes: tableRoutes(relation.name) }));

      await this.di.prisma.$transaction(async transaction => {
        await this.di.SchemaService.executeRaw(sql, transaction);
        for (const route of newRoutes) {
          await this.di.RlsService.applyPreset(route.table, policyPreset, transaction);
        }
      });
      this.logNewRoutes(newRoutes);
      return apiResponse.successResponseWithData(res, 'Created', {
        newRoutes: newRoutes.length ? newRoutes : undefined,
        // The console renders this as a plain notice, so an operator is not left
        // wondering why their new table has no endpoints and no policies.
        notRestExposed: elsewhere.length
          ? elsewhere.map(relation => `${relation.schema}.${relation.name}`)
          : undefined,
      });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/schema/tables/:table')
  @before(adminOnly)
  async dropTable(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.SchemaService.dropTable(req.params.table, req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'Dropped', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/schema/tables/:table/columns')
  @before(adminOnly)
  async addColumn(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.SchemaService.addColumn(req.params.table, req.body, req.query.schema as string | undefined);
      const tables = await this.di.SchemaService.listTables();
      const table = tables.find(t => t.name === req.params.table);
      return apiResponse.successResponseWithData(res, 'Added', { table });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/schema/tables/:table/columns/:column/rename')
  @before(adminOnly)
  async renameColumn(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.SchemaService.renameColumn(req.params.table, req.params.column, req.body.name, req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'Renamed', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/schema/tables/:table/columns/:column/nullable')
  @before(adminOnly)
  async setColumnNullable(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.SchemaService.setColumnNullable(req.params.table, req.params.column, Boolean(req.body.nullable), req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'Updated', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/schema/tables/:table/columns/:column/default')
  @before(adminOnly)
  async setColumnDefault(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.SchemaService.setColumnDefault(req.params.table, req.params.column, req.body.value ?? null, req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'Updated', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/schema/tables/:table/columns/:column')
  @before(adminOnly)
  async dropColumn(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.SchemaService.dropColumn(req.params.table, req.params.column, req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'Dropped', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/schema/tables/:table/indexes')
  @before(adminOnly)
  async listIndexes(req: Request, res: Response, next: NextFunction) {
    try {
      const indexes = await this.di.SchemaService.listIndexes(req.params.table, req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'OK', { indexes });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/schema/tables/:table/indexes')
  @before(adminOnly)
  async createIndex(req: Request, res: Response, next: NextFunction) {
    try {
      const { columns, unique, method, name, schema } = parseInput(createIndexBody, req.body);
      // The schema is a query parameter like every route here; the body form
      // is what an assistant tool call sends, since its POSTs carry no query.
      const target = (req.query.schema as string | undefined) ?? schema;
      await this.di.SchemaService.createIndex(req.params.table, columns, unique, method, target, name);
      return apiResponse.successResponseWithData(res, 'Created', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/schema/indexes/:name')
  @before(adminOnly)
  async dropIndex(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.SchemaService.dropIndex(req.params.name, req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'Dropped', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/schema/functions')
  @before(adminOnly)
  async listFunctions(req: Request, res: Response, next: NextFunction) {
    try {
      const functions = await this.di.SchemaService.listFunctions(req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'OK', { functions });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/schema/functions')
  @before(adminOnly)
  async createFunction(req: Request, res: Response, next: NextFunction) {
    try {
      const { sql } = req.body as { sql: string };
      if (!sql?.trim()) throw new HttpException('sql is required', 400);
      await this.di.SchemaService.createOrReplaceFunction(sql);
      return apiResponse.successResponseWithData(res, 'Created', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/schema/functions/:signature')
  @before(adminOnly)
  async dropFunction(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.SchemaService.dropFunction(decodeURIComponent(req.params.signature));
      return apiResponse.successResponseWithData(res, 'Dropped', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/schema/triggers')
  @before(adminOnly)
  async listTriggers(req: Request, res: Response, next: NextFunction) {
    try {
      const triggers = await this.di.SchemaService.listTriggers(req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'OK', { triggers });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/schema/trigger-functions')
  @before(adminOnly)
  async listTriggerFunctions(req: Request, res: Response, next: NextFunction) {
    try {
      const functions = await this.di.SchemaService.listTriggerFunctions(req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'OK', { functions });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/schema/triggers')
  @before(adminOnly)
  async createSchemaTrigger(req: Request, res: Response, next: NextFunction) {
    try {
      const { sql } = req.body as { sql: string };
      if (!sql?.trim()) throw new HttpException('sql is required', 400);
      await this.di.SchemaService.createTrigger(sql);
      return apiResponse.successResponseWithData(res, 'Created', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/schema/triggers/:name/enabled')
  @before(adminOnly)
  async setSchemaTriggerEnabled(req: Request, res: Response, next: NextFunction) {
    try {
      const { table, enabled } = req.body as { table: string; enabled: boolean };
      if (!table?.trim()) throw new HttpException('table is required', 400);
      await this.di.SchemaService.setTriggerEnabled(table, req.params.name, Boolean(enabled), req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'Updated', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/schema/triggers/:name')
  @before(adminOnly)
  async dropSchemaTrigger(req: Request, res: Response, next: NextFunction) {
    try {
      const table = req.query.table as string | undefined;
      if (!table?.trim()) throw new HttpException('table is required', 400);
      await this.di.SchemaService.dropTrigger(table, req.params.name, req.query.schema as string | undefined);
      return apiResponse.successResponseWithData(res, 'Dropped', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  /**
   * What the REST API actually serves, for the API Docs screen.
   *
   * Separate from `/admin/tables`, which lists every table in every schema: REST
   * exposes `public` base tables only, and documenting the rest produces
   * endpoints that 404.
   */
  @GET()
  @route('/rest/resources')
  @before(adminOnly)
  async listRestResources(_req: Request, res: Response, next: NextFunction) {
    try {
      const resources = await this.di.RestApiService.listResources();
      return apiResponse.successResponseWithData(res, 'OK', { resources });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/schema/extensions')
  @before(adminOnly)
  async listExtensions(_req: Request, res: Response, next: NextFunction) {
    try {
      const extensions = await this.di.SchemaService.listExtensions();
      return apiResponse.successResponseWithData(res, 'OK', { extensions });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/schema/extensions/:name')
  @before(adminOnly)
  async enableExtension(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.SchemaService.enableExtension(req.params.name);
      return apiResponse.successResponseWithData(res, 'Enabled', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/schema/extensions/:name')
  @before(adminOnly)
  async disableExtension(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.SchemaService.disableExtension(req.params.name);
      return apiResponse.successResponseWithData(res, 'Disabled', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  private logNewRoutes(newRoutes: { table: string; routes: { method: string; path: string }[] }[]) {
    const buffer = this.di.logBuffer;
    if (!buffer?.push || !newRoutes.length) return;
    for (const { table, routes } of newRoutes) {
      const lines = routes.map(r => `  ${r.method.padEnd(6)} ${r.path}`).join('\n');
      buffer.push({
        level: 'info',
        source: 'schema',
        message: `[schema] Table "${table}" created: REST API routes ready:\n${lines}`,
      });
    }
  }
}
