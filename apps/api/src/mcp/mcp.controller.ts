import { FORM_TEMPLATES, loadFormTemplate, type JsonSchema, type UiSchema } from '@careos/schemas';
import { Controller, Get, NotFoundException, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { Public } from '../common/public.decorator.js';

interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

interface McpToolList {
  readonly protocolVersion: '2024-11-05';
  readonly serverInfo: {
    readonly name: 'careos-api';
    readonly version: '0.0.0';
  };
  readonly tools: readonly McpToolDescriptor[];
}

interface FormTemplateCatalogueItem {
  readonly id: string;
  readonly version: string;
  readonly title: string;
}

interface FormTemplateResponse {
  readonly template: {
    readonly id: string;
    readonly version: string;
    readonly title: string;
    readonly schema: JsonSchema;
    readonly ui_schema: UiSchema;
  };
}

@ApiTags('mcp')
@Public()
@Controller('mcp')
export class McpController {
  @Get()
  @ApiOkResponse({ description: 'Phase 0 MCP capability advertisement.' })
  tools(): McpToolList {
    return this.toolList();
  }

  @Get('tools/list-form-templates')
  @ApiOkResponse({ description: 'Catalogue of schema-driven form templates.' })
  listFormTemplates(): { readonly templates: readonly FormTemplateCatalogueItem[] } {
    return {
      templates: FORM_TEMPLATES.map((template) => ({
        id: template.id,
        title: template.title,
        version: template.version,
      })),
    };
  }

  @Get('tools/get-form-template')
  @ApiOkResponse({ description: 'JSON Schema and UI Schema for a form template.' })
  getFormTemplate(
    @Query('template_id') templateId: string | undefined,
    @Query('version') version = 'v1',
  ): FormTemplateResponse {
    if (!templateId) {
      throw new NotFoundException('Missing template_id.');
    }

    try {
      const loaded = loadFormTemplate(templateId, version);
      return {
        template: {
          id: loaded.ref.id,
          schema: loaded.schema,
          title: loaded.ref.title,
          ui_schema: loaded.uiSchema,
          version: loaded.ref.version,
        },
      };
    } catch {
      throw new NotFoundException(`Unknown form template ${templateId}@${version}.`);
    }
  }

  @Post()
  @ApiOkResponse({ description: 'Phase 0 MCP JSON-RPC stub.' })
  handle(): Record<string, unknown> {
    return { id: null, jsonrpc: '2.0', result: this.toolList() };
  }

  private toolList(): McpToolList {
    return {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'careos-api', version: '0.0.0' },
      tools: [
        {
          description: 'List available CareOS form templates.',
          inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
          name: 'list-form-templates',
        },
        {
          description: 'Fetch a CareOS form template JSON Schema and UI Schema.',
          inputSchema: {
            additionalProperties: false,
            properties: {
              template_id: { type: 'string' },
              version: { default: 'v1', type: 'string' },
            },
            required: ['template_id'],
            type: 'object',
          },
          name: 'get-form-template',
        },
      ],
    };
  }
}
