This file is a merged representation of the entire codebase, combined into a single document by Repomix.

<file_summary>
This section contains a summary of this file.

<purpose>
This file contains a packed representation of the entire repository's contents.
It is designed to be easily consumable by AI systems for analysis, code review,
or other automated processes.
</purpose>

<file_format>
The content is organized as follows:
1. This summary section
2. Repository information
3. Directory structure
4. Repository files (if enabled)
5. Multiple file entries, each consisting of:
  - File path as an attribute
  - Full contents of the file
</file_format>

<usage_guidelines>
- This file should be treated as read-only. Any changes should be made to the
  original repository files, not this packed version.
- When processing this file, use the file path to distinguish
  between different files in the repository.
- Be aware that this file may contain sensitive information. Handle it with
  the same level of security as you would the original repository.
</usage_guidelines>

<notes>
- Some files may have been excluded based on .gitignore rules and Repomix's configuration
- Binary files are not included in this packed representation. Please refer to the Repository Structure section for a complete list of file paths, including binary files
- Files matching patterns in .gitignore are excluded
- Files matching default ignore patterns are excluded
- Files are sorted by Git change count (files with more changes are at the bottom)
</notes>

</file_summary>

<directory_structure>
src/
  components/
    ErrorBoundary.tsx
    ShowAfterTimeout.tsx
  context/
    RenderContext.tsx
  form/
    exmapleSchemas/
      apply.method.json
      array-schema.method.json
      delete.method.json
      oneOf.json
    globalProperties/
      align.json
      case.json
      fontWeight.json
      margin.json
      transformTranslate.json
    tools/
      generateComponentUrl.ts
      generatePath.ts
      getDefaultValue.tsx
      getFormSize.tsx
      index.ts
      mapRange.ts
      useFieldValue.ts
    context.tsx
    formItem.tsx
    index.tsx
    parser.tsx
    ref.tsx
    types.ts
  hooks/
    use-save-shortcut.tsx
    useImmer.ts
    useInputState.ts
    useStorage.ts
    useSwrSync.ts
    useToggle.ts
  make-icon/
    icomoon-gen.mjs
    icomoon.css
    Icon.tsx
    index.tsx
    types.ts
    with-tooltip.tsx
  render/
    Render.tsx
  store/
    create-loader-store.ts
    create-store.ts
    loading.ts
  theme/
    provider/
      emotion.d.ts
      theme-entity.ts
      ThemeProvider.tsx
      types.ts
      use-token.ts
    additional-tokens.ts
    index.ts
    types.ts
  txt/
    react/
      layout.jsx
  utils/
    portal/
      index.tsx
      types.ts
    emotion-omit-props.ts
    image.ts
    normalizeComponentSize.tsx
  context.ts
  form.ts
  hooks.ts
  index.ts
  store.ts
  theme.ts
  utils.ts
test/
  code/
    uix-export.jsx
  react/
    default.jsx
    uix-require.jsx
.npmignore
CHANGELOG.md
emotion.d.ts
global.d.ts
package.json
rollup.config.mjs
tsconfig.json
</directory_structure>

<files>
This section contains the contents of the repository's files.

<file path="src/components/ErrorBoundary.tsx">
import React from 'react';

export class ErrorBoundary extends React.Component<any, { error?: Error }> {
  constructor(props: any) {
    super(props);
    this.state = { error: undefined };
  }

  static getDerivedStateFromError(error: any) {
    // Update state so the next render will show the fallback UI.
    return { error };
  }

  componentDidUpdate(prevProps: any) {
    if (prevProps.children.props?.id !== this.props.children?.props?.id) {
      this.setState({ error: undefined });
    }
  }

  componentDidCatch(error: Error, errorInfo: any) {
    // You can also log the error to an error reporting service
    // logErrorToMyService(error, errorInfo);
  }

  render() {
    const { error } = this.state;
    // useEffect(() => {
    //   if (error) console.error('ErrorBoundary', error);
    // }, [error]);
    if (error) {
      console.error('ErrorBoundary', error.stack);
      // You can render any custom fallback UI

      return (
        <div className="error-wrapper">
          <div className="error-button">
            <span className="error-text">Error</span>
            <span className="error-button-text">?</span>
            <pre className="card error error-full-text">{error.stack}</pre>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
</file>

<file path="src/components/ShowAfterTimeout.tsx">
import { FC, PropsWithChildren, useLayoutEffect, useState } from 'react';

function useLoadingTimeout(ms: number): boolean {
  const [loading, setLoading] = useState(false);
  useLayoutEffect(() => {
    const id = setTimeout(() => {
      setLoading(true);
    }, ms);
    return () => clearTimeout(id);
  }, []);

  return loading;
}

export const ShowAfterTimeout: FC<PropsWithChildren & { timeout: number }> = ({
  children,
  timeout,
}) => {
  const showChild = useLoadingTimeout(timeout);
  return showChild ? children : null;
};
</file>

<file path="src/context/RenderContext.tsx">
import { createContext, ReactNode, useContext } from 'react';

const RENDER_CONTEXT = {
  DEFAULT: '',
  EDIT: 'edit',
  RENDER: 'render',
  WIDGET: 'widget',
  FORM: 'form',
} as const;

type RenderContextType = (typeof RENDER_CONTEXT)[keyof typeof RENDER_CONTEXT];

const RenderContext = createContext<RenderContextType>(RENDER_CONTEXT.DEFAULT);

const RenderContextProvider: React.FC<{ children: ReactNode; value: RenderContextType }> = ({
  children,
  value,
}) => {
  return <RenderContext.Provider value={value}>{children}</RenderContext.Provider>;
};

const useRenderContext = (): string => {
  const context = useContext(RenderContext);

  // TODO: should we throw an error if the context is not set? or just use default context.
  // if (!context) {
  //   throw new Error(`useRenderContext must be used within an RenderProvider`);
  // }

  return context;
};

export { RENDER_CONTEXT, RenderContextProvider, useRenderContext };
export type { RenderContextType };
</file>

<file path="src/form/exmapleSchemas/apply.method.json">
{
  "$id": "https://treenity.pro/schemas/schema.json",
  "title": "k8s.method.apply",
  "description": "k8s Service Apply method",
  "type": "object",
  "required": [
    "in"
  ],
  "properties": {
    "in": {
      "type": "object",
      "required": [
        "items"
      ],
      "properties": {
        "testBoolean": {
          "type": "boolean"
        },
        "testComponent": {
          "$ref": "/schemas/ui/text/default"
        },
        "test1": {
          "$ref": "#/$defs/friend"
        },
        "test3": {
          "$ref": "http://localhost:5173/static/delete.method.json"
        },
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "group",
              "format",
              "content"
            ],
            "properties": {
              "group": {
                "title": "Группа",
                "type": "string"
              },
              "format": {
                "type": "string"
              },
              "content": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  },
  "$defs": {
    "friend": {
      "type": "object",
      "properties": {
        "name": {
          "title": "Friend string",
          "type": "string"
        },
        "friends": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/friend"
          }
        }
      }
    }
  }
}
</file>

<file path="src/form/exmapleSchemas/array-schema.method.json">
{
  "$id": "https://treenity.pro/schemas/schema.json",
  "title": "k8s.method.apply",
  "description": "k8s Service Apply method",
  "type": "object",
  "required": [
    "in"
  ],
  "properties": {
    "in": {
      "type": "object",
      "required": [
        "items"
      ],
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "group",
              "format",
              "content"
            ],
            "properties": {
              "group": {
                "title": "Группа",
                "type": "string"
              },
              "format": {
                "type": "string"
              },
              "content": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  }
}
</file>

<file path="src/form/exmapleSchemas/delete.method.json">
{
  "$id": "http://example.com/schemas/defs.json",
  "title": "k8s.method.delete",
  "description": "k8s Service Delete method",
  "type": "object",
  "required": [
    "in",
    "out"
  ],
  "properties": {
    "in": {
      "description": "",
      "type": "object",
      "required": [
        "group"
      ],
      "properties": {
        "items": {
          "type": "object",
          "required": [
            "group"
          ],
          "properties": {
            "group": {
              "type": "string"
            }
          }
        }
      }
    },
    "out": {
      "description": "",
      "type": "object",
      "properties": {
      }
    }
  }
}
</file>

<file path="src/form/exmapleSchemas/oneOf.json">
{
  "title": "Schema dependencies",
  "description": "These samples are best viewed without live validation.",
  "type": "object",
  "required": ["first"],
  "properties": {
    "first": {
      "title": "First",
      "type": "string",
      "default": "Test field"
    },
    "conditional": {
      "title": "Conditional",
      "$ref": "#/definitions/person"
    }
  },
  "definitions": {
    "person": {
      "title": "Person",
      "type": "object",
      "properties": {
        "Do you have any pets?": {
          "type": "string",
          "enum": ["No", "Yes: One", "Yes: More than one"],
          "default": "No",
          "widget": "react.antd.select"
        }
      },
      "required": ["Do you have any pets?"],
      "dependencies": {
        "Do you have any pets?": {
          "oneOf": [
            {
              "properties": {
                "Do you have any pets?": {
                  "enum": ["No"]
                }
              }
            },
            {
              "properties": {
                "Do you have any pets?": {
                  "enum": ["Yes: One"]
                },
                "What kind of?": {
                  "type": "string",
                  "enum": ["Cat", "Dog"]
                },
                "How old is your pet?": {
                  "type": "number"
                }
              },
              "required": ["How old is your pet?"]
            },
            {
              "properties": {
                "Do you have any pets?": {
                  "enum": ["Yes: More than one"]
                },
                "Do you want to get rid of any?": {
                  "type": "boolean"
                }
              },
              "required": ["Do you want to get rid of any?"]
            }
          ]
        },
        "Do you want to get rid of any?": {
          "oneOf": [
            {
              "properties": {
                "Do you want to get rid of any?": {
                  "enum": [true]
                },
                "How many?": {
                  "type": "number"
                }
              }
            }
          ]
        },
        "How old is your pet?": {
          "oneOf": [
            {
              "properties": {
                "How old is your pet?": {
                  "enum": [14, 15, 16, 17, 18, 19, 20]
                },
                "Wow, so long": {
                  "type": "number"
                }
              }
            }
          ]
        }
      }
    }
  }
}
</file>

<file path="src/form/globalProperties/align.json">
{
  "textAlign": {
    "title": "Text align",
    "type": "string",
    "default": "left",
    "enum": [
      {
        "icon": "align-left_outlined",
        "value": "left"
      }, {
        "icon": "align-center_outlined",
        "value": "center"
      }, {
        "icon": "align-right_outlined",
        "value": "right"
      }, {
        "icon": "align-justify_outlined",
        "value": "justify"
      }
    ],
    "widget": "react.antd.radio-button"
  }
}
</file>

<file path="src/form/globalProperties/case.json">
{
  "case": {
    "title": "Case",
    "type": "string",
    "default": "none",
    "enum": [{
      "label": "-",
      "value": "none"
    },{
      "label":"Ab",
      "value": "capitalize"
    },{
      "label":"AB",
      "value": "uppercase"
    },{
      "label": "ab",
      "value": "lowercase"
    }],
    "widget": "react.antd.radio-button"
  }
}
</file>

<file path="src/form/globalProperties/fontWeight.json">
{
  "fontWeight": {
    "title": "Font weight",
    "type": "number",
    "default": 400,
    "enum": [{
      "label": "100 - Thin",
      "value": 100
    },{
      "label":"200 - Extra Light",
      "value": 200
    },{
      "label":"300 - Light",
      "value": 300
    },{
      "label": "400 - Normal",
      "value": 400
    },{
      "label": "500 - Medium",
      "value": 500
    },{
      "label": "600 - Semi Bold",
      "value": 600
    },{
      "label": "700 - Bold",
      "value": 700
    },{
      "label": "800 - Extra Bold",
      "value": 800
    },{
      "label": "900 - Black",
      "value": 900
    }],
    "widget": "react.antd.select"
  }
}
</file>

<file path="src/form/globalProperties/margin.json">
{
  "margin": {
    "type": "string",
    "minimum": 0,
    "length": 4,
    "subtitle": "Margin",
    "widget": "css.full-custom-size"
  }
}
</file>

<file path="src/form/globalProperties/transformTranslate.json">
{
  "transformTranslate": {
    "type": "string",
    "title": null,
    "min": 0,
    "length": 2,
    "subtitle": "Transform translate",
    "widget": "css.full-custom-size"
  }
}
</file>

<file path="src/form/tools/generateComponentUrl.ts">
const getComponentUrl = (refUrl: string) => {
  if (refUrl.startsWith('/schemas/')) {
    return refUrl?.slice(9).replaceAll('/', '.');
  }
  return refUrl;
};

export default getComponentUrl;
</file>

<file path="src/form/tools/generatePath.ts">
const generatePath = (path: string[], key?: string): string[] => {
  if (!key) {
    return path;
  }
  return path.concat(key);
};

export default generatePath;
</file>

<file path="src/form/tools/getDefaultValue.tsx">
export type ItemType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'ref';

export default function getDefaultValue(type: ItemType, value: any) {
  if (value) {
    return value;
  }

  switch (type) {
    case 'string':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    case 'ref':
      return {};
    default:
      return {};
  }
}
</file>

<file path="src/form/tools/getFormSize.tsx">
import { SizeType } from 'antd/es/config-provider/SizeContext';
import { TSizeForm } from '../types';

const defaultSize: Record<TSizeForm, SizeType | undefined> = {
  sm: 'small',
  md: 'middle',
  lg: 'large',
  xs: undefined,
};

const getFormSize = (size: TSizeForm | undefined) => (size ? defaultSize[size] : undefined);

export default getFormSize;
</file>

<file path="src/form/tools/index.ts">
export { default as generatePath } from './generatePath';
export { default as generateComponentUrl } from './generateComponentUrl';
export { default as getDefaultValue } from './getDefaultValue';
export { default as mapRange } from './mapRange';
export * from './useFieldValue';
export { default as getFormSize } from './getFormSize';
</file>

<file path="src/form/tools/mapRange.ts">
type mapFunction<T> = (k: number) => T;

const mapRange = <T>(length: number, callback: mapFunction<T>) =>
  Array.from({ length }, (_, k) => callback(k));

export default mapRange;
</file>

<file path="src/form/tools/useFieldValue.ts">
import { Form } from 'antd';
import { FormInstance } from 'antd/es/form/hooks/useForm';

export const useFieldValueSubscribe = (form: FormInstance, formPath: string[]) =>
  Form.useWatch(formPath, form);
</file>

<file path="src/form/context.tsx">
import { createContext, FC, memo, PropsWithChildren, useContext, useMemo } from 'react';
import { IRegistryComponentProps } from './types';

type TreenityContext = {
  isForm: boolean;
  Title?: FC<PropsWithChildren<IRegistryComponentProps>>;
  fieldProps?: Record<string, any>;
};

const TreenityFormContext = createContext<TreenityContext>({ isForm: false });

const useTreenityForm = () => {
  const context = useContext(TreenityFormContext);
  if (!context) {
    throw new Error('TreenityFormContext not found');
  }
  return context;
};

const TreenityFormProvider: FC<PropsWithChildren<TreenityContext>> = ({
  isForm,
  fieldProps,
  Title,
  children,
}) => {
  const value = useMemo(() => ({ isForm: true, fieldProps, Title }), [fieldProps, Title]);
  return <TreenityFormContext.Provider value={value}>{children}</TreenityFormContext.Provider>;
};

export { TreenityFormProvider, useTreenityForm, TreenityContext };
</file>

<file path="src/form/formItem.tsx">
import { IRegistryComponentProps } from './types';
import styled from '@emotion/styled';
import { Form } from 'antd';
import { FC, memo, PropsWithChildren } from 'react';

const makeRules = (required: boolean) => [
  {
    required,
    message: 'required',
  },
];

const FormItemHandler: FC<PropsWithChildren<IRegistryComponentProps & { url?: string }>> = ({
  options,
  children,
  initialValue,
  url,
}) => {
  return (
    <FormItemStyled
      label={options.label}
      name={options.path}
      initialValue={options.defaultValue ?? initialValue}
      required={options.required}
      rules={makeRules(options.required)}
    >
      {children}
    </FormItemStyled>
  );
};

const FormItemStyled = styled(Form.Item)`
  .ant-row,
  .ant-col,
  .ant-form-item-control-input,
  .ant-form-item-control-input-content {
    max-width: 100%;
  }
`;

export default memo(FormItemHandler);
</file>

<file path="src/form/index.tsx">
import styled from '@emotion/styled';
import { throttle } from '@s-libs/micro-dash';
import { JSONSchema7 } from '@treenity/json-schema';
import { Button, Form } from 'antd';
import type { FormLayout } from 'antd/es/form/Form';
import { createContext, FC, memo, PropsWithChildren, useEffect, useMemo } from 'react';
import { TreenityFormProvider, useTreenityForm } from './context';
import ParseForm from './parser';
import { IRegistryComponentProps, TSizeForm } from './types';

const TreenityFormContext = createContext<boolean>(false);

export type { TSizeForm };

export interface IMetaFormProps {
  schema: JSONSchema7;
  initialValues?: any;
  onChange?(fieldValue: any, metaValue: any): void;
  onSubmit?(value: any): void;
  formSize?: TSizeForm;
  layout?: FormLayout;
  buttonSaveText?: string;
  renderContext?: string;
  fieldProps?: Record<string, any>;
  Title?: FC<PropsWithChildren<IRegistryComponentProps>>;
}

const labelCol = { span: 5 };
const wrapperCol = { span: 19 };

const FormHandler: FC<IMetaFormProps> = ({
  schema,
  onSubmit,
  initialValues,
  onChange,
  formSize,
  Title,
  layout,
  buttonSaveText = 'Save',
  renderContext = 'form',
  fieldProps,
}) => {
  const [form] = Form.useForm();

  const throttledSetFieldsVlaue = useMemo(() => {
    return throttle(values => {
      form.setFieldsValue(values);
    }, 2000);
  }, [form]);

  useEffect(() => {
    throttledSetFieldsVlaue(initialValues);
  }, [initialValues, throttledSetFieldsVlaue]);

  const { isForm } = useTreenityForm();

  if (isForm) {
    return (
      <FormStyled labelCol={labelCol} wrapperCol={wrapperCol} onValuesChange={onChange}>
        <ParseForm formSize={formSize} item={schema} form={form} renderContext={renderContext} />
      </FormStyled>
    );
  }

  return (
    <FormStyled
      form={form}
      layout={layout}
      labelCol={labelCol}
      wrapperCol={wrapperCol}
      onFinish={onSubmit}
      onValuesChange={onChange}
    >
      <TreenityFormProvider isForm={true} fieldProps={fieldProps} Title={Title}>
        <ParseForm formSize={formSize} item={schema} form={form} renderContext={renderContext} />
      </TreenityFormProvider>
      {!onChange && (
        <FormItemStyled>
          <Button type="primary" htmlType="submit">
            {buttonSaveText}
          </Button>
        </FormItemStyled>
      )}
    </FormStyled>
  );
};

const FormStyled = styled(Form)`
  .ant-row {
    display: grid;
    grid-template-columns: 74px 1fr;
  }
  .ant-form-item-row {
    gap: 8px;
  }
  & > .ant-form-item {
    padding-inline: 10px;
  }

  .ant-form-item {
    margin-bottom: 0px;
  }

  .ant-form-item-label {
    text-align: start;
    align-items: center;
    display: flex;

    label {
      margin: 0;
      -webkit-transition: color 0.2s cubic-bezier(0.78, 0.14, 0.15, 0.86);
      transition: color 0.2s cubic-bezier(0.78, 0.14, 0.15, 0.86);
      font-size: 10px;
      line-height: 140%;
      letter-spacing: -0.2px;
      font-weight: 700;
      line-height: 1;
      width: 72px;
      line-height: 20px;
      align-self: baseline;

      &::before,
      &::after {
        display: none !important;
      }
    }
  }
`;

const FormItemStyled = styled(Form.Item)`
  margin-bottom: 0;
`;

export default memo(FormHandler);
</file>

<file path="src/form/parser.tsx">
import { FormInstance } from 'antd/es/form/hooks/useForm';
import { FC, memo, useMemo } from 'react';
import FormOptions, { ISizeForm } from './types';
import FormItemHandler from './formItem';
import { JsonObjectSchema, JSONSchema7, refResolver } from '@treenity/json-schema';
import { Render } from '#render/Render';
import { useSwrSync } from '#hooks/useSwrSync';
import { useTreenityForm } from './context';

interface IParseForm extends ISizeForm {
  item: JSONSchema7;
  formPath?: string[];
  required?: string[];
  schema?: JSONSchema7;
  dependencies?: Record<string, JSONSchema7 | string[]>;
  renderContext?: string;
  form?: FormInstance;
}

const getUrlSchema = (schema: JSONSchema7, renderContext: string, type: string) => {
  if (typeof schema.widget === 'object' && schema.widget?.[renderContext]) {
    return schema.widget[renderContext];
  } else if (typeof schema.widget === 'string') {
    return schema.widget;
  }

  return type;
};

const ParseForm: FC<IParseForm> = ({
  item,
  formPath = [],
  required = [],
  schema,
  formSize,
  renderContext = 'form',
  form,
}) => {
  let type: string = (
    Array.isArray(item.type) ? item[0].type || item.anyOf?.[0].type : item.type
  ) as string;
  if (!type) {
    if (Array.isArray(item) ? item.at(0).$ref : item.$ref) {
      type = 'ref';
    }
  }

  const { data: resolvedRef } = useSwrSync(item.$ref ? `load-schema-${item.$ref}` : null, () =>
    refResolver({
      item: item,
      schema: schema!,
    }),
  );

  function fixItem(item: JSONSchema7): JsonObjectSchema {
    if (item.type === 'array' && item.widget) {
      return {
        ...(item as object),
        widget: null,
        type: 'array',
        items: {
          ...item.items,
          widget: item.widget,
        },
      };
    }

    // @ts-ignore
    return resolvedRef ? { ...resolvedRef, ...item } : item;
  }
  const { Title, fieldProps } = useTreenityForm();

  const options = useMemo(
    () =>
      new FormOptions({
        _required: required,
        path: formPath,
        title: item?.title,
        fieldProps,
        type,
        formSize,
        item: fixItem(item),
        disabled: item.disabled,
        schema: schema || item,
        renderContext,
        form,
      }),
    [resolvedRef, fieldProps],
  );

  const url = getUrlSchema(fixItem(item), renderContext, type);

  if (!url) {
    return null;
  }

  if (url === 'array' || url === 'object') {
    if (Title) {
      return (
        <Title options={options}>
          <Render context="form" value={'DONT_REMOVE'} url={url} options={options} />
        </Title>
      );
    }
    return <Render context="form" value={'DONT_REMOVE'} url={url} options={options} />;
  }

  if (url === 'ref') {
    return <Render context="form" value={'DONT_REMOVE'} url={url} options={options} />;
  }

  return (
    <FormItemHandler options={options}>
      <Render context="form" url={url} options={options} />
    </FormItemHandler>
  );
};

export default memo(ParseForm);
</file>

<file path="src/form/ref.tsx">
import { IRegistryComponentProps } from '#form/types';
import { types } from '@treenity/core';
import { JSONSchema7, refResolver } from '@treenity/json-schema';
import { FC } from 'react';
import { Render } from '#render/Render';
import { useSwrSync } from '#hooks/useSwrSync';
import FormItemHandler from './formItem';
import { generateComponentUrl } from './tools';
import ParseForm from './parser';

const RefParser: FC<IRegistryComponentProps> = ({ options, fieldProps, ...rest }) => {
  const refUrl = options.item.$ref;
  const componentUrl = generateComponentUrl(refUrl!);
  const { data } = useSwrSync(
    `load-component-${componentUrl}`,
    () => types.react.get('form', componentUrl),
    { revalidate: false },
  );

  if (data) {
    return (
      <FormItemHandler options={options}>
        <Render context="form" url={componentUrl} options={options} />
      </FormItemHandler>
    );
  }

  // @ts-ignore
  const { data: schema, error } = useSwrSync(`load-schema-${refUrl}`, () => refResolver(options));
  if (error) return <div>Error loading schema: {error.message}</div>;
  if (!schema) {
    return null;
  }

  return (
    <ParseForm
      form={options.form}
      item={schema as JSONSchema7}
      formPath={options.path}
      schema={options.schema}
      formSize={options.formSize}
    />
  );
};

export default RefParser;
</file>

<file path="src/form/types.ts">
import { JSONSchema7 } from '@treenity/json-schema';
import { FormInstance } from 'antd/es/form/hooks/useForm';
import { FC, ReactNode } from 'react';

export type TSizeForm = 'xs' | 'sm' | 'md' | 'lg';

export interface ISizeForm {
  formSize?: TSizeForm;
}

export interface IRegistryComponentProps {
  options: FormOptions;
  [key: string]: any;
}

export type FieldProps<TValue = unknown, TFieldProps = unknown> = {
  'aria-required'?: string;
  context: string;
  id: string;
  url: string;
  value: TValue;
  onChange: (value: TValue) => void;
  options: FormOptions<TFieldProps>;
};

export type FieldRenderer<T = unknown, D = {}> = (props: FieldProps<T, D>) => ReactNode;

export type RegistryComponentValue = FC<IRegistryComponentProps>;

export interface IRegistryComponent {
  [key: string]: RegistryComponentValue;
}

export interface IFormOptions<TFieldProps = unknown> {
  type: string;
  path: string[];
  title?: string;
  key?: string;
  item: JSONSchema7;
  formSize?: TSizeForm;
  _required?: string[];
  schema?: JSONSchema7;
  disabled: boolean;
  renderContext?: string;
  form?: FormInstance;
  fieldProps: TFieldProps;
}

class FormOptions<TFieldProps = unknown> implements IFormOptions<TFieldProps> {
  key?: string;
  title?: string;
  path: string[];
  type: string;
  item: JSONSchema7;
  schema?: JSONSchema7;
  formSize?: TSizeForm;
  _required?: string[];
  disabled: boolean;
  renderContext?: string;
  form?: FormInstance;
  fieldProps: TFieldProps;

  constructor(options: IFormOptions<TFieldProps>) {
    this._required = options._required || [];
    this.title = options.title;
    this.path = options.path;
    this.type = options.type;
    this.formSize = options.formSize;
    this.item = options.item;
    this.schema = options.schema;
    this.renderContext = options.renderContext;
    this.disabled = options.disabled || false;
    this.form = options.form;
    this.fieldProps = options.fieldProps;

    if (!options.fieldProps) {
      throw new Error('fieldProps is required');
    }

    if (this.path?.length) {
      this.key = this.path.at(-1);
    }
  }

  public get defaultValue(): any {
    return this.item.default || this.item.defaultValue;
  }

  private getLabelFromPath(): string | undefined {
    if (!this.path || !this.path.length) {
      return;
    }

    return this.path.at(-1);
  }

  public get label(): string | undefined {
    if (this.title === null) {
      return undefined;
    }
    if (this.title) {
      return String(this.title);
    }

    return this.getLabelFromPath() || '';
  }

  public get required(): boolean {
    if (!this.key) {
      return false;
    }

    return this._required?.includes(this.key) || false;
  }

  public getParam(key: string, defaultValue: any): any {
    // @ts-ignore
    return this.item[key] || defaultValue;
  }
}

export default FormOptions;
</file>

<file path="src/hooks/use-save-shortcut.tsx">
import { useEffect, useRef } from 'react';

const _document = typeof document !== 'undefined' ? document : null;

type SaveCallback = () => void | Promise<void>;

/**
 * Hook that blocks default browser save event & adds Ctrl+S/Cmd+S shortcut listener
 * @param onSaved - Callback function to be called when the save shortcut is triggered
 * @param doc - The document object to attach the listener to (default: document)
 * @example
 * ```tsx
 * // Basic usage
 * useSaveShortcut(() => console.log('Saved!'));
 *
 * // Usage with iframe document
 * const [iframeRef, setIframeRef] = useState<HTMLIFrameElement | null>(null);
 * useSaveShortcut(handleSave, iframeRef?.contentDocument);
 * ```
 */
export const useSaveShortcut = (onSaved?: SaveCallback, doc: Document | null = _document): void => {
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    if (!doc) return;

    const handleKeyDown = async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();

        if (!e.repeat) {
          await onSavedRef.current?.();
        }
      }
    };

    doc.addEventListener('keydown', handleKeyDown);
    return () => doc.removeEventListener('keydown', handleKeyDown);
  }, [doc]);
};
</file>

<file path="src/hooks/useImmer.ts">
import { useCallback, useState } from 'react';
import { produce } from 'immer';

type ImmerCallback<T> = (val: T) => T | void;

export function useImmer<T>(initial: T | (() => T)): [T, (cb: ImmerCallback<T> | T) => void] {
  const [data, setData] = useState(initial);
  const setImmer = useCallback(
    (cb: ImmerCallback<T> | T) =>
      // @ts-ignore in `produce(data, cb)` cb is not assignable, but we know, it is function
      typeof cb === 'function' ? setData(data => produce(data, cb)) : setData(cb),
    [setData],
  );
  return [data, setImmer];
}
</file>

<file path="src/hooks/useInputState.ts">
import { Dispatch, SetStateAction, useCallback, useState } from 'react';

type StateUpdater<T> = Dispatch<SetStateAction<T>>;

export function useInputState<T>(initial: T): [T, StateUpdater<T>] {
  const [value, setValue] = useState<T>(initial);
  const setInputValue = useCallback<StateUpdater<T>>(
    (e: any) => {
      const value =
        e && 'target' in e ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
      setValue(value);
    },
    [setValue],
  );
  return [value, setInputValue];
}
</file>

<file path="src/hooks/useStorage.ts">
import { useCallback, useState } from 'react';

function useStorage<T>(key: string): [T | undefined, (v: T | undefined) => void];
function useStorage<T>(key: string, defaultValue: T): [T, (v: T | undefined) => void];

function useStorage<T>(key: string, defaultValue?: T): [T | undefined, (v: T | undefined) => void] {
  if (typeof window === 'undefined') {
    return [defaultValue, () => {}];
  }

  const [value, setValue] = useState<T | undefined>(() => {
    const storageValue = localStorage.getItem(key);
    try {
      return storageValue ? (JSON.parse(storageValue) as T) : defaultValue;
    } catch (err) {
      console.warn('localstorage', key, 'parse error', err);
      localStorage.setItem(key, JSON.stringify(defaultValue));
      return defaultValue;
    }
  });
  const setFn = useCallback((v: T | undefined) => {
    if (v === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(v));
    }
    setValue(v);
  }, []);

  return [value, setFn];
}

export default useStorage;
</file>

<file path="src/hooks/useSwrSync.ts">
import { useRef } from 'react';
import useSWR, { SWRConfiguration, SWRResponse } from 'swr';

export type Configuration = SWRConfiguration & { revalidate?: boolean };

const SWR_DONT_REVALIDATE = {
  revalidateIfStale: false,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
};

// TODO: write tests
/**
 * Sync version of useSWR, run its callback synchronously, and could resolve synchronous-promise,
 * it will reduce flicker if component could be loaded from cache
 * @param id
 * @param cb
 * @param config
 */
export function useSwrSync<T>(
  id: string | null,
  cb: () => Promise<T> | T,
  config: Configuration = {},
): SWRResponse<T> {
  const isFirst = useRef(true);
  if (config.revalidate === false) {
    config = Object.assign({}, SWR_DONT_REVALIDATE, config);
  }

  let prom: any;
  const result = useSWR(id, () => prom || cb(), config);
  // try resolve promise synchronously (yes, we using synchronous-promise package for this)
  if (isFirst.current) {
    isFirst.current = false;
    let error;
    try {
      prom = cb();
    } catch (err) {
      error = err;
    }
    if (prom) {
      if (typeof prom.then === 'function') {
        let value;
        prom.then(
          v => (value = v),
          err => (error = err),
        );
        if (value != undefined) return { ...result, data: value };
      } else {
        return { ...result, data: prom };
      }
    }
    if (error) {
      return { ...result, error };
    }
  }

  return result;
}

export function useSwrSync2<T>(
  id: string | null,
  cb: () => Promise<T> | T,
  config: Configuration = {},
): { data?: T; error?: Error } {
  const isFirst = useRef(true);

  const use = next => {
    return (key, fn, config) => {
      const result = next(key, fn, config);
      if (isFirst.current) {
        isFirst.current = false;
        let error;
        let value;
        try {
          value = fn();
        } catch (err) {
          error = err;
        }
        if (value != undefined) return { ...result, data: value };
        if (error) {
          return { ...result, error };
        }
      }
      return result;
    };
  };

  if (config.revalidate === false) {
    config = Object.assign({ use }, SWR_DONT_REVALIDATE, config);
  }

  let prom: any;
  const result = useSWR(id, () => prom || cb(), config);
  // try resolve promise synchronously (yes, we using synchronous-promise package for this)
  if (isFirst.current) {
    isFirst.current = false;
    let error;
    try {
      prom = cb();
    } catch (err) {
      error = err;
    }
    if (prom) {
      if (typeof prom.then === 'function') {
        let value;
        prom.then(
          v => (value = v),
          err => (error = err),
        );
        if (value != undefined) return { ...result, data: value };
      } else {
        return { ...result, data: prom };
      }
    }
    if (error) {
      return { ...result, error };
    }
  }

  return result;
}
</file>

<file path="src/hooks/useToggle.ts">
import { useCallback, useState } from 'react';

export default function useToggle(start: boolean = false): [boolean, (value?: any) => void] {
  const [value, setValue] = useState<boolean>(start);
  const toggle = useCallback(
    (value?: any) => setValue(prevValue => (typeof value === 'boolean' ? value : !prevValue)),
    [],
  );
  return [value, toggle];
}
</file>

<file path="src/make-icon/icomoon-gen.mjs">
#!/usr/bin/env node

import fs from 'node:fs';

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf-8'));
}

const dataJson = readJson('./icomoon/selection.json');
const dataStylePath = './icomoon/style.css';
const fontsDir = './icomoon/fonts';

const array = dataJson.icons.map(i => i.properties.name);

let buf = 'const iconNames = [\n';

const iconTypes = ['filled', 'outlined'];

let errorTypeIcons = [];

array.sort().forEach(i => {
  const [, type] = i.split('_');
  if (!type && !iconTypes.includes(type)) {
    errorTypeIcons.push(i);
  }

  buf += `  '${i}',\n`;
});

if (errorTypeIcons.length > 0) {
  console.error('\x1b[32m%s\x1b[0m', errorTypeIcons);
  throw new Error(`unknown icon type: ${errorTypeIcons}, should end with: '_' and ${iconTypes}`);
}

buf += '] as const;\n';
buf += 'export default iconNames;\n';

fs.writeFileSync('./icons-names.ts', buf);

fs.readdir(fontsDir, (err, files) => {
  if (err) {
    console.error(`Failed to read directory: ${err.message}`);
    return;
  }
  files.forEach(file => {
    if (file.split('.').at(-1) === 'svg') {
      const filePath = `${fontsDir}/${file}`;
      try {
        fs.rmSync(filePath);
        console.log(`File deleted: ${filePath} 👍`);
      } catch (err) {
        console.error(`Failed to delete file: ${filePath}, error: ${err.message}`);
      }
    }
  });
});

function removeSvgFontEntry(filePath) {
  const cssContent = fs.readFileSync(filePath, 'utf-8');
  const updatedContent = cssContent.replace(
    /,\s*url\('fonts\/[^']+\.svg\?[^']+'\)\s*format\('svg'\)/gm,
    '',
  );
  fs.writeFileSync(filePath, updatedContent, 'utf-8');
}

removeSvgFontEntry('./icomoon/style.css');
removeSvgFontEntry(dataStylePath);

const iconRegex = /\.icon-([a-zA-Z0-9-_]+):before\s*{\s*content:\s*"\\([a-fA-F0-9]+)";\s*}/gm;
const cssContent = fs.readFileSync(dataStylePath, 'utf-8');

if (!cssContent) {
  console.log(`file ` + dataStylePath + ` not found`);
}

const iconsObject = {};

let match;
while ((match = iconRegex.exec(cssContent)) !== null) {
  const iconName = match[1];
  const iconCode = match[2];
  iconsObject[iconName] = `\\\\${iconCode}`;
}

let tsContent = 'const iconObject = {\n';

for (const [key, value] of Object.entries(iconsObject)) {
  tsContent += `  '${key}': '${value}',\n`;
}

tsContent += '};\n';
tsContent += 'export default iconObject;\n';

fs.writeFileSync('./icons-object.ts', tsContent, 'utf-8');

console.log('Icons object created successfully.');
</file>

<file path="src/make-icon/icomoon.css">
:where([class^="icon-"]), :where([class*=" icon-"]) {
  font-size: 24px;
}


@keyframes icon-rotation {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
</file>

<file path="src/make-icon/Icon.tsx">
import { IIcon } from '#make-icon/types';
import { omitProps } from '#utils/emotion-omit-props';
import { css } from '@emotion/react';
import styled from '@emotion/styled';
import React from 'react';
import './icomoon.css';

function IconUnstyled({ name, className, style }: IIcon<string[]>) {
  return <i className={`icon-${name} ${className}`} style={style} />;
}

const colorTable: Record<string, string> = {
  default: 'colorText',
  danger: 'colorError',
  primary: 'colorPrimary',
  gray: 'colorTextQuaternary',
};

const Icon = styled(IconUnstyled, omitProps('spin', 'color', 'rotate'))<
  Pick<IIcon<any>, 'rotate' | 'spin' | 'color'>
>`
  ${p => css`
    transition: transform ${p.theme.motionDurationMid} ${p.theme.motionEaseInOutCirc};
    transform: ${(p.rotate || p.rotate === 0) && `rotate(${p.rotate}deg)`};
  `};

  ${({ spin }) =>
    spin &&
    css`
      transform-origin: 52%;
      animation: icon-rotation ${typeof spin === 'boolean' ? 1 : spin}s linear infinite;
      display: block;
    `};

  ${p =>
    p.color &&
    css`
      color: ${(p.theme as any)?.[colorTable[p.color] || p.color] || p.color};
    `};
`;

export default Icon;
</file>

<file path="src/make-icon/index.tsx">
import { FC } from 'react';
import Icon from './Icon';

import { IconNames, IIcon } from './types';

export default function makeIcon<T extends IconNames>(iconNames: T): FC<IIcon<T>> {
  return Icon as unknown as FC<IIcon<T>>;
}
</file>

<file path="src/make-icon/types.ts">
import { CSSProperties } from 'react';
import '../emotion';

export type IconThemesMap = 'default' | 'danger' | 'gray' | 'primary' | string;

export type IconNames = readonly string[];

export interface IIcon<T extends IconNames> {
  name: T[number];
  color?: IconThemesMap;
  className?: string;
  style?: CSSProperties;
  styleIcon?: CSSProperties;
  rotate?: number; // angle to rotate icon to
  spin?: boolean | number; // boolean or number of seconds to make full rotation
}

export interface IErrorProps<T extends IconNames> {
  name: T[number];
  isIconStyle: boolean;
  includeIcon: boolean;
}
</file>

<file path="src/make-icon/with-tooltip.tsx">
import { Tooltip } from 'antd';
import { FC, ReactNode } from 'react';
import Icon from './Icon';
import { IIcon } from './types';

export function makeIconWithTooltip<T extends string[]>(iconsNames: T): FC<IIcon<T>> {
  const iconNamesHash: Record<string, boolean> = {};
  iconsNames.forEach(name => {
    iconNamesHash[name] = true;
  });

  return function IconWithTooltip<T extends string[]>(props: IIcon<T>) {
    const error = !props.name ? (
      'icon not found, name is not correct'
    ) : !iconNamesHash[props.name] ? (
      <>
        Type for icon <b>{props.name}</b> not found
      </>
    ) : undefined;

    if (error) return <ErrorTooltip error={error} />;

    return <Icon {...props} />;
  };
}

const DefaultIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 1024 1024">
    <path
      fill="#fa6900"
      d="M60 256v512c0 108 88 196 196 196h512c108 0 196-88 196-196V256c0-108-88-196-196-196H256C148 60 60 148 60 256zm452 9c24 0 43 19 43 42v205a43 43 0 1 1-86 0V307c0-23 19-42 43-42zm0 356c24 0 43 19 43 43v2a43 43 0 1 1-86 0v-2c0-24 19-43 43-43z"
    />
  </svg>
);

const ErrorTooltip: FC<{ error: ReactNode }> = ({ error }) => (
  <Tooltip title={error} getPopupContainer={() => document.body}>
    <div style={{ width: 24 }}>
      <DefaultIcon />
    </div>
  </Tooltip>
);
</file>

<file path="src/render/Render.tsx">
import { ErrorBoundary } from '#components/ErrorBoundary';
import { ShowAfterTimeout } from '#components/ShowAfterTimeout';
import { useRenderContext } from '#context/RenderContext';
import { useSwrSync } from '#hooks/useSwrSync';
import {
  IReactContextProps,
  Meta,
  metaType,
  Node,
  ReactTypeContextInfo,
  types,
} from '@treenity/core';
import { FC, PropsWithChildren } from 'react';

export type TFC<T, P = {}, N extends Node = Node> = FC<IReactContextProps<T, P, N>>;

export type TFCC<T, P = {}, N extends Node = Node> = FC<
  PropsWithChildren<IReactContextProps<T, P, N>>
>;

export interface RenderURLProps {
  url: string;
  children?: any;

  loading?: () => JSX.Element;
  loader?: (props: RenderURLProps) => ReactTypeContextInfo | Promise<ReactTypeContextInfo>;

  [more: string]: any;
}

let Render = function Render(props: RenderURLProps) {
  const ctx = useRenderContext();
  const { data: componentInfo, error } = useSwrSync<ReactTypeContextInfo>(
    `render_${props.context ?? ctx}_${props.url}`,
    () =>
      props.loader ? props.loader(props) : types.react.getInfo(props.context ?? ctx, props.url),
    props.swr,
  );

  const { url, fallback, render, loading, loaderHook, value: _value, ...other } = props;

  // @ts-ignore
  const value = _value ?? componentInfo?.options?.default;

  if (!props.swr?.suspense) {
    if (value == null) {
      return <>Loading ...</>;
    }
  }

  if (!componentInfo) {
    if (fallback !== undefined) return fallback(props);
    return error ? (
      `not found ${url}`
    ) : (
      <ShowAfterTimeout timeout={200}>Loading. ff..</ShowAfterTimeout>
    );
  }

  let {
    component: Component,
    options: { props: componentProps },
  } = componentInfo;

  const allProps = { ...componentProps, ...other, value, url };

  // @ts-ignore
  const result = <Component {...allProps} />;

  return render ? render(result, allProps) : result;
};

// if (process.env.NODE_ENV !== 'production') {
const RenderOrig = Render;
Render = (props: RenderURLProps) => <ErrorBoundary>{RenderOrig(props)}</ErrorBoundary>;
// }

export { Render };

export const render = (url: string, defProps: any) => (props: any) =>
  Render({ url, ...defProps, ...props });

interface IRenderMetaProps extends Omit<RenderURLProps, 'url'> {
  value: Meta;
  // node: NodeLoader;
  context?: string;
}

export const RenderMeta = ({ value, node, ...props }: IRenderMetaProps) => {
  if (!value) {
    return null;
  }
  return Render({ ...props, url: value.$.type.$type, value, node });
};

interface IRenderType extends Omit<RenderURLProps, 'url'> {
  type: Meta;
  metaName?: string;
}

export const RenderType = ({ node, type, metaName, swr, ...props }: IRenderType) => {
  type = metaType(type);
  let { data: value } = useSwrSync(
    `render_type_${node?.path}_${type.$type}_${metaName || ''}`,
    async () => {
      const meta = await node.get(type, metaName);
      return meta;
    },
    swr ? swr : { revalidate: false },
  );

  let url = type.$type;

  // if (!value) {
  //   return <>Loading...</>;
  // }

  return <Render {...props} url={url} node={node} value={value} swr={swr} />;
};
</file>

<file path="src/store/create-loader-store.ts">
import { useLoading } from '#tree/loading';
import { Draft } from 'immer';
import { useMemo } from 'react';
import useSwr, { SWRResponse } from 'swr';
import { createStore, StateCreator } from './create-store';

export interface LoadState<T> {
  useLoad(): void;
}

interface LoadStateLoader<T> extends LoadState<T> {
  useLoader<R>(
    key: string,
    fetcher: () => Promise<R>,
    callback: (store: Draft<T>, result: R) => void,
  ): SWRResponse<R>;
}

export type StateCreatorLoader<T> = (
  set: Parameters<StateCreator<T>>[0],
  get: Parameters<StateCreator<T & LoadStateLoader<T>>>[1], // get has some additional functions
  store: Parameters<StateCreator<T>>[2],
) => T & LoadState<T>;
type LoaderStore<T> = ReturnType<typeof createStore<T & LoadStateLoader<T>>>;
export const createLoaderStore = <T>(stateCreator: StateCreatorLoader<T>): LoaderStore<T> => {
  type TL = T & LoadStateLoader<T>;

  const stateWithLoader: StateCreatorLoader<T> = (set, get, store) => {
    const state = stateCreator(set, get, store) as TL;
    let first = true;
    state.useLoader = (key, fetcher, callback) => {
      return useSwr(
        key,
        () => {
          const loadingOff = useLoading.getState().set(key, first);
          return fetcher()
            .then(result => {
              set(state => {
                callback(state, result);
              });
              return result;
            })
            .finally(() => {
              loadingOff();
              first = false;
            });
        },
        typeof window !== 'undefined' &&
          // @ts-ignore
          window.ENV?.NODE_ENV === 'development' &&
          // @ts-ignore
          window.ENV?.ENABLE_SWR_UPDATE_IN_DEV !== 'true'
          ? {
              revalidateIfStale: false,
              revalidateOnFocus: false,
              revalidateOnReconnect: false,
            }
          : undefined,
      );
    };

    return state;
  };

  // @ts-ignore
  const useStore = createStore<TL>(stateWithLoader);

  type Store = typeof useStore;

  const store = () => {
    const store = useStore();
    store.useLoad();
    return store;
  };
  (store as Store).getState = useStore.getState;
  (store as Store).setState = useStore.setState;
  (store as Store).subscribe = useStore.subscribe;

  // @ts-ignore
  return store;
};

export const createComponentStore =
  <T, P extends any[]>(creatorCreator: (...args: P) => StateCreatorLoader<T>) =>
  (...args: P) => {
    const useStore = useMemo(() => createLoaderStore<T>(creatorCreator(...args)), args);
    const store = useStore();
    store.useLoad();
    return store;
  };
</file>

<file path="src/store/create-store.ts">
import { mutate } from 'swr';
import { create } from 'zustand';
import type { PersistOptions } from 'zustand/middleware';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
enableMapSet();

export type StateCreator<T> = Parameters<typeof immer<T>>[0];

export const createStore = <T>(storeCreator: StateCreator<T>) => create(immer<T>(storeCreator));

export const createStorageStore = <T, U>(
  options: PersistOptions<T, U>,
  storeCreator: StateCreator<T>,
) =>
  typeof window === 'undefined' // SSR
    ? createStore<T>(storeCreator)
    : create(persist(immer<T>(storeCreator), options));

export const invalidate = (key: string) => mutate(key, undefined, true);
</file>

<file path="src/store/loading.ts">
import { createStore } from './create-store';

export interface LoadersStore {
  loading: Record<string, boolean>;

  set(key: string, value: boolean): () => void;
  get(key: string): boolean;

  subscribe(key: string, listener: (value: { isLoading: boolean }) => void): boolean;
}

export const useLoading = createStore<LoadersStore>((set, get, store) => ({
  loading: {},

  set(key: string, value: boolean): () => void {
    set(state => {
      state.loading[key] = value;
    });
    return () => {
      set(state => {
        state.loading[key] = false;
      });
    };
  },

  get(key: string): boolean {
    return !!get().loading[key];
  },

  subscribe(key: string, listener: (value: { isLoading: boolean }) => void): boolean {
    store.subscribe(state => {
      listener({ isLoading: state.loading[key] });
    });
    return get().loading[key];
  },
}));
</file>

<file path="src/theme/provider/emotion.d.ts">
/*
 * Copyright (c) 2024. Treenity Inc.
 */

import { MergedTokensComponents } from '../types';
// import { OverrideToken } from 'antd';
//
// declare module '@emotion/react' {
//   export interface Theme {
//     token: ThemeToken;
//     components: OverrideToken;
//   }
// }
import 'antd';

declare module '@emotion/react' {
  export interface Theme extends MergedTokensComponents {}
}

declare namespace antd {
  export const _default: {
    useToken(): {
      token: any;
      hashId: string;
    };
  };
}
</file>

<file path="src/theme/provider/theme-entity.ts">
/*
 * Copyright (c) 2024. Treenity Inc.
 */

import { metaType } from '@treenity/core';
import { entity, writeMethod } from '@treenity/entity';
import { MergedConfig, Theme, ThemeConfig } from '../types';

@entity('theme')
export class ThemeEntity implements Theme {
  name!: string;
  config!: ThemeConfig;

  get key() {
    return this.name;
  }

  @writeMethod
  setConfig(config: MergedConfig) {
    this.config = config;
  }
}
</file>

<file path="src/theme/provider/ThemeProvider.tsx">
/*
 * Copyright (c) 2024. Treenity Inc.
 */

import { Theme as ETheme, ThemeProvider as EmotionThemeProvider } from '@emotion/react';
import { ConfigProvider, theme } from 'antd';
import React, { createContext, FC, PropsWithChildren, useContext, useMemo } from 'react';
import { MergedTokens, Theme } from '../types';
import { IThemeContext } from './types';
import { Locale } from 'antd/es/locale';

const { useToken } = theme;

export const ThemeContext: React.Context<IThemeContext> = createContext<IThemeContext>(null!);
export const useCurrentTheme = () => useContext(ThemeContext);

// type Themes = { [key: string]: ThemeConfig };
// const THEMES: Themes = {
//   light: lightTheme,
//   dark: darkTheme,
// };

const InnerThemeProvider: FC<PropsWithChildren<Omit<IThemeContext, 'theme'>>> = ({
  themeName,
  setTheme,
  themes,
  children,
  onChange,
}) => {
  const token = useToken();
  const emotionTheme = useMemo(
    () =>
      ({
        ...token.token,
        //@ts-ignore
        token: token.token as MergedTokens,
      }) as ETheme,
    [token],
  );

  return (
    <ThemeContext.Provider value={{ themeName, setTheme, themes, onChange }}>
      <EmotionThemeProvider theme={emotionTheme}>{children}</EmotionThemeProvider>
    </ThemeContext.Provider>
  );
};

const configProviderWave = { disabled: true };

const getPopupContainer = (triggerNode?: HTMLElement) => triggerNode?.parentNode as HTMLElement;

export const ThemeProvider: FC<
  PropsWithChildren<{
    light: Theme;
    dark: Theme;
    storedThemeName: string;
    setThemeName(themeName: string): void;
    onChange?: (themeField: string, value: any) => void;
    locale?: Locale;
  }>
> = ({ children, light, dark, setThemeName, storedThemeName, locale, onChange }) => {
  const { theme, themes } = useMemo(() => {
    const sourceTheme = storedThemeName === 'dark' ? dark : light;

    const theme: any = sourceTheme.config;
    theme.algorithm = sourceTheme.config.algorithm;

    const themes = [light, dark];

    const currentTheme = themes.find(theme => theme.name === storedThemeName) || themes[0];
    if (storedThemeName != currentTheme.name) {
      setThemeName(currentTheme.name);
    }

    return { theme, themes };
  }, [dark.config, light.config, storedThemeName]);

  return (
    <ConfigProvider
      wave={configProviderWave}
      //@ts-ignore
      theme={theme}
      getPopupContainer={getPopupContainer}
      locale={locale}
    >
      <InnerThemeProvider
        themeName={storedThemeName}
        setTheme={setThemeName}
        themes={themes}
        children={children}
        onChange={onChange}
      />
    </ConfigProvider>
  );
};
</file>

<file path="src/theme/provider/types.ts">
/*
 * Copyright (c) 2024. Treenity Inc.
 */

import { Theme } from '../types';

export interface IThemeContext {
  themeName: string;
  themes: Theme[];
  setTheme(theme: string): void;
  onChange?: (themeField: string, value: any) => void;
}
</file>

<file path="src/theme/provider/use-token.ts">
/*
 * Copyright (c) 2024. Treenity Inc.
 */

import { theme } from 'antd';
import { MergedTokensComponents } from '../types';

type UseTokenResult = Omit<ReturnType<typeof theme.useToken>, 'token'> & {
  token: MergedTokensComponents;
};

export function useToken(): UseTokenResult {
  // @ts-ignore
  return theme.useToken() as UseTokenResult;
}
</file>

<file path="src/theme/additional-tokens.ts">
/*
 * Copyright (c) 2024. Treenity Inc.
 */

export interface AdditionalTokens {
  advancedSiderWidth: number;
  advancedSiderCollapsedWidth: number;
  bodyBg: string;
  colorGrayText: string;
  gray400: string;
  colorBgPanel: string;
  colorBgContrast: string;
  colorBgSecondaryHover: string;
  gray500: string;
  gray700: string;
  colorBtnBgHover: string;
  colorBtnBgActive: string;
  base500: string;
  base600: string;
  base400: string;
  base700: string;
  error200: string;
  contrastingColorText: string;
  base: string;
  Avatar: {
    colorTextLightSolid: string;
    colorTextPlaceholder: string;
  };
  Layout: {
    triggerBg: string;
    colorBgElevated: string;
    siderBg: string;
    headerBg: string;
  };
  Panel: {
    colorBgContainer: string;
  };
  ColorPicker: {
    fontSizeSM: number;
    fontSizeXS: number;
    controlHeight: number;
    controlHeightSM: number;
    controlHeightLG: number;
    borderRadius: number;
    borderRadiusSM: number;
    borderRadiusLG: number;
  };
  colorBgItems: string;
  Button: {
    paddingBlockXL: string;
    paddingBlockXS: string;
    secOutlinedBg: string;
    secOutlinedColor: string;
    secOutlinedBorderColor: string;
    secOutlinedHoverBg: string;
    secOutlinedHoverColor: string;
    secOutlinedHoverBorderColor: string;
    secOutlinedActiveBg: string;
    secOutlinedActiveColor: string;
    secOutlinedActiveBorderColor: string;
    colorBgSecondaryHover: string;
    secFilledBg: string;
    secFilledColor: string;
    secFilledBorderColor: string;
    secFilledHoverBg: string;
    secFilledHoverColor: string;
    secFilledHoverBorderColor: string;
    secFilledActiveBg: string;
    secFilledActiveColor: string;
    secFilledActiveBorderColor: string;
    dangerFilledBg: string;
    dangerFilledColor: string;
    dangerFilledBorderColor: string;
    dangerFilledHoverBg: string;
    dangerFilledHoverColor: string;
    dangerFilledHoverBorderColor: string;
    dangerFilledActiveBg: string;
    dangerFilledActiveColor: string;
    dangerFilledActiveBorderColor: string;
    dangerOutlinedBg: string;
    dangerOutlinedColor: string;
    dangerOutlinedBorderColor: string;
    dangerOutlinedHoverBg: string;
    dangerOutlinedHoverColor: string;
    dangerOutlinedHoverBorderColor: string;
    dangerOutlinedActiveBg: string;
    dangerOutlinedActiveColor: string;
    dangerOutlinedActiveBorderColor: string;
    colorBgDangerHover: string;
    colorBgDanger: string;
    controlHeight: string;
    controlHeightXL: string;
    paddingInlineXL: string;
    paddingInlineXS: string;
    colorBorderHover: string;
    colorBgSecondary: string;
    colorBgSecondaryActive: string;
    borderRadiusXL: string;
  };
  Input: {
    colorBgContainer: string;
    controlHeightXL: string;
    controlHeightXS: string;
    inputFontSizeXL: string;
    borderRadiusXL: string;
    inputFontSizeXS: string;
    paddingInlineXL: string;
    paddingInlineXS: string;
  };
  Select: {
    borderRadiusDropdownXS: string;
    borderRadiusOptionXS: string;
    optionHeightXS: string;
    fontSizeXS: string;
  };
}
</file>

<file path="src/theme/index.ts">
/*
 * Copyright (c) 2024. Treenity Inc.
 */

export * from './types';
export { AdditionalTokens } from './additional-tokens';

export * from './provider/ThemeProvider';
export * from './provider/use-token';
export * from './provider/theme-entity';
export type { IThemeContext } from './provider/types';
</file>

<file path="src/theme/types.ts">
/*
 * Copyright (c) 2024. Treenity Inc.
 */

import type { ThemeConfig as AntdThemeConfig } from 'antd';
import { Theme as AntdTheme } from 'antd-token-previewer';
import { AdditionalTokens } from './additional-tokens';

export type MergedTokens = AntdThemeConfig['token'] & AdditionalTokens;
export type MergedTokensComponents<T = {}> = MergedTokens &
  AntdThemeConfig['components'] & {
    token: MergedTokens & T;
  } & T;

export type MergedConfig = Omit<AntdThemeConfig, 'token'> & {
  token: MergedTokens;
  appearance: string;
};
export type ThemeConfig = MergedConfig;

export type Theme = Omit<AntdTheme, 'config'> & {
  config: MergedConfig;
};
</file>

<file path="src/txt/react/layout.jsx">
function TxtLayout({ children }) {
  return <div>Layout:
    <div>{children}</div>
  </div>;
}

uix.add(TxtLayout);
</file>

<file path="src/utils/portal/index.tsx">
import { Component, createElement } from 'react';
import { createPortal } from 'react-dom';
import { IPortalHandlerProps, IPortalProps, IPortals } from './types';

const portals: IPortals = {};

export class PortalHandler extends Component<IPortalHandlerProps> {
  private element?: Element;

  componentDidMount() {
    const { name, multi } = this.props;
    let portal = portals[name];
    if (!this.element) return;

    if (!portal) {
      portal = { el: [this.element] };
      portals[name] = portal;
    } else if (!multi && portal.el?.length) {
      throw new Error(`Portal with name ${name} already exists`);
    } else {
      if (!portal.el) {
        portal.el = [];
      }
      portal.el?.push(this.element);
      if (portal.comp) {
        portal.comp.forceUpdate();
      }
    }
  }

  componentWillUnmount() {
    delete portals[this.props.name];
  }

  setRef = (ref: any) => (this.element = ref);

  render() {
    return createElement(this.props.component ?? 'span', { ref: this.setRef });
  }
}

export class Portal extends Component<IPortalProps> {
  render() {
    const { name, children } = this.props;

    if (!children) {
      return null;
    }

    const portal = portals[name];

    if (!portal || !portal.el) {
      portals[name] = { comp: this };
      return null;
    }
    return <>{portal.el.map((el, index) => createPortal(children, el))}</>;
  }
}
</file>

<file path="src/utils/portal/types.ts">
import type { PropsWithChildren } from 'react';

export interface IPortalProps extends PropsWithChildren {
  name: string;
}

export interface IPortals {
  [key: string]: IPortalsProps;
}

export interface IComponentPortal {
  forceUpdate(): void;
  el?: Element;
}

export interface IPortalsProps {
  comp?: IComponentPortal;
  el?: Element[];
}

export interface IPortalHandlerProps {
  name: string;
  component?: string;
  multi?: boolean;
}
</file>

<file path="src/utils/emotion-omit-props.ts">
export const omitProps = (...props: string[]) => ({
  shouldForwardProp: (name: string) => !props.includes(name) && name[0] !== '$',
});
</file>

<file path="src/utils/image.ts">
/*
 * Copyright (c) 2024. Treenity Inc.
 */

import { isClient } from '@treenity/js-shared';

// @ts-ignore
const API_URL = () => (isClient ? window.ENV.WS_API_URL : process.env.WS_API_URL);

export const createImageUrlFn =
  (defaultImage: string, defaultWidth: number, defaultHeight: number) =>
  (
    key?: string | null,
    width: number = defaultWidth,
    height: number = defaultHeight,
    defaultImg?: string,
  ) => {
    if (typeof key !== 'string' || !key || key.length < 1) {
      return defaultImg || defaultImage;
    }

    if (key?.startsWith('https://')) {
      return key;
    }

    return getImageUrl(width, height, key);
  };

//This action for get image from server
export const getImageUrl = (width: number, height: number, key: string) =>
  // `${API_URL()}/v1/image/${width}/${height}?key=${encodeURIComponent(key)}`;
  `${API_URL()}/api/sys/file?key=${encodeURIComponent(key)}&width=${width}&height=${height}`;

//This method for upload image
export const getImageAction = () => `${API_URL()}/api/sys/file`;
</file>

<file path="src/utils/normalizeComponentSize.tsx">
/*
 * Copyright (c) 2024. Treenity Inc.
 */

export type NormalizeSizeType = 'x-small' | 'small' | 'middle' | 'large' | 'x-large';

export const normalizeComponentSize = (size: NormalizeSizeType) => {
  if (size === 'x-large') {
    return 'large';
  }
  if (size === 'x-small') {
    return 'small';
  }
};
</file>

<file path="src/context.ts">
export * from './context/RenderContext';
</file>

<file path="src/form.ts">
export { default as SchemaForm } from './form/index';
export { default as ParseForm } from './form/parser';
export { default as RefParser } from './form/ref';
export * from './form/tools';
export * from './form/types';
</file>

<file path="src/hooks.ts">
export { default as useToggle } from './hooks/useToggle';
export { default as useStorage } from './hooks/useStorage';
export { useSwrSync } from './hooks/useSwrSync';
export * from './hooks/use-save-shortcut';
</file>

<file path="src/index.ts">
import type { IconNames, IIcon } from './make-icon/types';

export { default as makeIcon } from './make-icon';
export { makeIconWithTooltip } from './make-icon/with-tooltip';

export * from './components/ShowAfterTimeout';
export * from './components/ErrorBoundary';

export * from './store/create-store';

export * from './context';

export * from './render/Render';

export type { IIcon, IconNames };
</file>

<file path="src/store.ts">
export * from './store/create-store';
export * from './store/loading';
export * from './store/create-loader-store';
</file>

<file path="src/theme.ts">
export * from './theme/index';
</file>

<file path="src/utils.ts">
export * from './utils/emotion-omit-props';
export * from './utils/normalizeComponentSize';
export * from './utils/portal';
export * from './utils/image';
</file>

<file path="test/code/uix-export.jsx">
exports.helloWorld = () => {
  const str = 'Hello world!';
  console.log(str);
  return str;
};
</file>

<file path="test/react/default.jsx">
import ReactSelect from '/esmsh/react-select';
// const { default: ReactSelect } = await uix.require('https://esm.sh/v82/react-select@5.3.2/es2022/react-select.bundle.js');

const options = [{ label: 'test', value: 'test' } , { label: 'test1', value: 'test1' }];

uix.add(() => {
  const [value, setValue] = uix.React.useState();
  return <div>
    <div>Hello from test</div>
    <ReactSelect value={value} onChange={setValue} options={options}/>
  </div>;
});
</file>

<file path="test/react/uix-require.jsx">
const uixExports = await uix.require('uix:test/uix-export');

console.log('uixExports', uixExports);

const { helloWorld } = uixExports;

helloWorld();

uix.add(() => {
  return <div>{helloWorld()}</div>;
});
</file>

<file path=".npmignore">
src/
node_modules/
tsconfig.json
.prettierrc
.gitignore
.package-lock.json
.idea
.turbo
.npmrc
rollup.config.*
docs
typedoc.json
jest.config.*
types
dist/**/stats.html
</file>

<file path="CHANGELOG.md">
# @treenity/ui-components

## 2.1.80

### Patch Changes

- Update version
- Updated dependencies
  - @treenity/json-schema@0.1.41
  - @treenity/js-shared@1.0.35
  - @treenity/entity@0.5.41
  - @treenity/core@1.0.48

## 2.1.79

### Patch Changes

- Update version

## 2.1.78

### Patch Changes

- update version
- Updated dependencies
  - @treenity/json-schema@0.1.40
  - @treenity/core@1.0.47
  - @treenity/entity@0.5.40

## 2.1.77

### Patch Changes

- Update version

## 2.1.76

### Patch Changes

- Update version

## 2.1.75

### Patch Changes

- Update version

## 2.1.74

### Patch Changes

- Update version
- Updated dependencies
  - @treenity/js-shared@1.0.34
  - @treenity/entity@0.5.39
  - @treenity/core@1.0.46

## 2.1.73

### Patch Changes

- Updated dependencies
  - @treenity/entity@0.5.38
  - @treenity/core@1.0.45

## 2.1.72

### Patch Changes

- Update libs
- Updated dependencies
  - @treenity/js-shared@1.0.33
  - @treenity/entity@0.5.37
  - @treenity/core@1.0.44

## 2.1.71

### Patch Changes

- Update version
- Updated dependencies
  - @treenity/js-shared@1.0.32
  - @treenity/entity@0.5.36
  - @treenity/core@1.0.43

## 2.1.70

### Patch Changes

- Updated dependencies
  - @treenity/entity@0.5.35

## 2.1.69

### Patch Changes

- Update version
- Updated dependencies
  - @treenity/js-shared@1.0.31
  - @treenity/entity@0.5.34
  - @treenity/core@1.0.42

## 2.1.68

### Patch Changes

- Update version
- Updated dependencies
  - @treenity/entity@0.5.33

## 2.1.67

### Patch Changes

- Updated dependencies
  - @treenity/core@1.0.41
  - @treenity/entity@0.5.32

## 2.1.66

### Patch Changes

- Updated dependencies
  - @treenity/js-shared@1.0.30
  - @treenity/core@1.0.40
  - @treenity/entity@0.5.31

## 2.1.65

### Patch Changes

- Updated dependencies
  - @treenity/entity@0.5.30

## 2.1.64

### Patch Changes

- Update version

## 2.1.63

### Patch Changes

- Update version
- Updated dependencies
  - @treenity/entity@0.5.29

## 2.1.62

### Patch Changes

- Update version

## 2.1.61

### Patch Changes

- Update version

## 2.1.60

### Patch Changes

- Update webeditor config

## 2.1.59

### Patch Changes

- Update libs
- Updated dependencies
  - @treenity/js-shared@1.0.29
  - @treenity/entity@0.5.28
  - @treenity/core@1.0.39

## 2.1.58

### Patch Changes

- Updated dependencies
  - @treenity/core@1.0.38
  - @treenity/entity@0.5.27

## 2.1.57

### Patch Changes

- Updated dependencies
  - @treenity/js-shared@1.0.28
  - @treenity/core@1.0.37
  - @treenity/entity@0.5.26

## 2.1.56

### Patch Changes

- Update libs

## 2.1.55

### Patch Changes

- Update emotion

## 2.1.54

### Patch Changes

- Remove default theme from theme provider

## 2.1.53

### Patch Changes

- Fix editor

## 2.1.52

### Patch Changes

- Updated dependencies
  - @treenity/entity@0.5.25

## 2.1.51

### Patch Changes

- Update versions
- Updated dependencies
  - @treenity/entity@0.5.24
  - @treenity/core@1.0.36

## 2.1.50

### Patch Changes

- Update version
- Updated dependencies
  - @treenity/entity@0.5.23
  - @treenity/core@1.0.35

## 2.1.49

### Patch Changes

- update create feathers client in repositroy
- Updated dependencies
  - @treenity/js-shared@1.0.27
  - @treenity/core@1.0.34
  - @treenity/entity@0.5.22

## 2.1.48

### Patch Changes

- update version
- Updated dependencies
  - @treenity/js-shared@1.0.26
  - @treenity/entity@0.5.21
  - @treenity/core@1.0.33

## 2.1.47

### Patch Changes

- Update webeditor
- Updated dependencies
  - @treenity/entity@0.5.20

## 2.1.46

### Patch Changes

- Some change
- Updated dependencies
  - @treenity/js-shared@1.0.25
  - @treenity/entity@0.5.19
  - @treenity/core@1.0.32

## 2.1.45

### Patch Changes

- @treenity/entity@0.5.18

## 2.1.44

### Patch Changes

- Fix animation

## 2.1.43

### Patch Changes

- Updated dependencies
  - @treenity/js-shared@1.0.24
  - @treenity/entity@0.5.17
  - @treenity/core@1.0.31

## 2.1.42

### Patch Changes

- Add json files to a bundle

## 2.1.41

### Patch Changes

- Update libs
- Updated dependencies
  - @treenity/entity@0.5.16
  - @treenity/core@1.0.30

## 2.1.40

### Patch Changes

- Update webeditor and add new register component
- Updated dependencies
  - @treenity/core@1.0.29
  - @treenity/entity@0.5.15

## 2.1.39

### Patch Changes

- Updated libs
- Updated dependencies
  - @treenity/entity@0.5.14

## 2.1.38

### Patch Changes

- Fix lower case login, add access check in rest

## 2.1.37

### Patch Changes

- Update components

## 2.1.36

### Patch Changes

- Some updates

## 2.1.35

### Patch Changes

- Update image work

## 2.1.34

### Patch Changes

- Fix styles in admin components
- Updated dependencies
  - @treenity/entity@0.5.13
  - @treenity/core@1.0.28

## 2.1.33

### Patch Changes

- Fix bugs

## 2.1.32

### Patch Changes

- other changes

## 2.1.31

### Patch Changes

- Giga update
- Updated dependencies
  - @treenity/entity@0.5.12
  - @treenity/core@1.0.27

## 2.1.30

### Patch Changes

- Fix outline button colors

## 2.1.29

### Patch Changes

- Update components and theme

## 2.1.28

### Patch Changes

- Bug fix

## 2.1.27

### Patch Changes

- Update components

## 2.1.26

### Patch Changes

- Update components

## 2.1.25

### Patch Changes

- Move the theme editor to admin-components

## 2.1.24

### Patch Changes

- Fix theme provider theme merging

## 2.1.23

### Patch Changes

- Update components

## 2.1.22

### Patch Changes

- fix exchanger default and fix ui-kit

## 2.1.21

### Patch Changes

- Update components

## 2.1.20

### Patch Changes

- Update libs
- Updated dependencies
  - @treenity/entity@0.5.11

## 2.1.19

### Patch Changes

- Many updates
- Updated dependencies
  - @treenity/js-shared@1.0.23
  - @treenity/core@1.0.26
  - @treenity/entity@0.5.10

## 2.1.18

### Patch Changes

- Add translate and some changes

## 2.1.17

### Patch Changes

- Update version

## 2.1.16

### Patch Changes

- Add logs and fixed icons

## 2.1.15

### Patch Changes

- Update libs
- Updated dependencies
  - @treenity/core@1.0.25

## 2.1.14

### Patch Changes

- Updated dependencies
  - @treenity/js-shared@1.0.22
  - @treenity/core@1.0.24

## 2.1.13

### Patch Changes

- Add entity and other changes
- Updated dependencies
  - @treenity/js-shared@1.0.21
  - @treenity/core@1.0.23

## 2.1.12

### Patch Changes

- some changes

## 2.1.11

### Patch Changes

- Update deps
- Updated dependencies
  - @treenity/js-shared@1.0.20
  - @treenity/core@1.0.22

## 2.1.10

### Patch Changes

- Updated dependencies
  - @treenity/core@1.0.21

## 2.1.9

### Patch Changes

- Updated dependencies
  - @treenity/js-shared@1.0.19
  - @treenity/core@1.0.20

## 2.1.8

### Patch Changes

- Update something
- Updated dependencies
  - @treenity/js-shared@1.0.18
  - @treenity/core@1.0.19

## 2.1.7

### Patch Changes

- Update version for stabilization build
- Updated dependencies
  - @treenity/js-shared@1.0.17

## 2.1.6

### Patch Changes

- Add types
- Updated dependencies
  - @treenity/js-shared@1.0.16

## 2.1.5

### Patch Changes

- Updated dependencies
  - @treenity/js-shared@1.0.15

## 2.1.4

### Patch Changes

- Update versions
- Updated dependencies
  - @treenity/js-shared@1.0.14

## 2.1.3

### Patch Changes

- Update versions

## 2.1.2

### Patch Changes

- Add portal

## 2.1.1

### Patch Changes

- Update icons

## 2.1.0

### Minor Changes

- Add useToggle

## 2.0.8

### Patch Changes

- Some changes
- Updated dependencies
  - @treenity/js-shared@1.0.13

## 2.0.7

### Patch Changes

- Updated packages version
- Updated dependencies
  - @treenity/js-shared@1.0.12

## 2.0.6

### Patch Changes

- Updated libs

## 2.0.5

### Patch Changes

- Updated libs

## 2.0.4

### Patch Changes

- Updated dependencies
  - @treenity/streams@1.0.20

## 2.0.3

### Patch Changes

- Updated libs
- Updated dependencies
  - @treenity/streams@1.0.19
  - @treenity/js-shared@1.0.11

## 2.0.2

### Patch Changes

- Updated dependencies
  - @treenity/streams@1.0.18

## 2.0.1

### Patch Changes

- Changed version
- Updated dependencies
  - @treenity/streams@1.0.17
  - @treenity/js-shared@1.0.10

## 2.0.0

### Major Changes

- Fixed bugs

## 1.0.7

### Patch Changes

- Fix type script error and add missing package

## 1.0.6

### Patch Changes

- Updated libs
- Updated dependencies
  - @treenity/js-shared@1.0.9

## 1.0.5

### Patch Changes

- 95f4620: update ui-kit

## 1.0.5

### Patch Changes

- Updated dependencies
  - @treenity/js-shared@1.0.8

## 1.0.4

### Patch Changes

- Fixed build

## 1.0.3

### Patch Changes

- Updated versions
- Updated dependencies
  - @treenity/js-shared@1.0.5

## 1.0.2

### Patch Changes

- Updated version to update new front-proxy
- Updated dependencies
  - @treenity/js-shared@1.0.4
</file>

<file path="emotion.d.ts">
import { MergedTokensComponents } from './dist/theme/types';

declare module '@emotion/react' {
  export interface Theme extends MergedTokensComponents {}
}
</file>

<file path="global.d.ts">
declare module '*.module.scss';
</file>

<file path="package.json">
{
  "name": "@treenity/ui-kit",
  "version": "2.1.80",
  "description": "txt.dev ui kit",
  "author": "Treenity",
  "license": "ISC",
  "scripts": {
    "build": "rollup -c",
    "watch": "rollup -c -w",
    "clean": "treenity-clean",
    "portmanager:test": "jest ./src/test/*"
  },
  "bin": {
    "icomoon-gen": "./src/make-icon/icomoon-gen.mjs"
  },
  "type": "module",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.mjs"
    },
    "./utils": {
      "types": "./dist/utils.d.ts",
      "default": "./dist/utils.mjs"
    },
    "./hooks": {
      "types": "./dist/hooks.d.ts",
      "default": "./dist/hooks.mjs"
    },
    "./store": {
      "types": "./dist/store.d.ts",
      "default": "./dist/store.mjs"
    },
    "./form": {
      "types": "./dist/form.d.ts",
      "default": "./dist/form.mjs"
    },
    "./theme": {
      "types": "./dist/theme.d.ts",
      "default": "./dist/theme.mjs"
    },
    "./styles.css": "./dist/assets/styles.css"
  },
  "typesVersions": {
    "*": {
      ".": [
        "./dist/index.d.ts"
      ],
      "form": [
        "./dist/form.d.ts"
      ],
      "utils": [
        "./dist/utils.d.ts"
      ],
      "hooks": [
        "./dist/hooks.d.ts"
      ],
      "store": [
        "./dist/store.d.ts"
      ],
      "theme": [
        "./dist/theme.d.ts"
      ]
    }
  },
  "files": [
    "/dist/**/*.d.ts",
    "/dist/**/*.mjs",
    "/dist/**/*.json",
    "/dist/assets",
    "package.json"
  ],
  "dependencies": {
    "@ant-design/cssinjs": "^1.22.0",
    "@s-libs/micro-dash": "^17.1.0",
    "@treenity/core": "1.0.48",
    "@treenity/entity": "0.5.41",
    "@treenity/js-shared": "1.0.35",
    "@treenity/json-schema": "0.1.41",
    "antd-token-previewer": "^2.0.8",
    "classnames": "^2.5.1",
    "immer": "10.0.3",
    "lodash": "npm:@s-libs/micro-dash@^18.0.0",
    "rc-util": "^5.38.1",
    "react-colorful": "^5.6.1",
    "react-layout-kit": "^1.7.4",
    "swr": "2.3.0",
    "tinycolor2": "^1.6.0",
    "tslib": "^2.8.1",
    "use-debouncy": "^5.0.1",
    "zustand": "^4.5.5"
  },
  "peerDependencies": {
    "@emotion/react": "^11.13.5",
    "@emotion/styled": "^11.13.5",
    "antd": "^5.22.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@emotion/react": "^11.13.5",
    "@emotion/styled": "^11.13.5",
    "@treenity/build-utils": "1.1.32",
    "@treenity/tsconfig": "1.0.14",
    "@types/lodash": "npm:@s-libs/micro-dash@^18.0.0",
    "@types/react": "18.2.51",
    "@types/react-dom": "18.2.18",
    "css": "^3.0.0",
    "jest": "^29.7.0",
    "resize-observer-polyfill": "^1.5.1",
    "rollup": "^4.26.0",
    "rollup-plugin-copy": "3.5.0",
    "sass": "^1.70.0",
    "typescript": "^5.4.5",
    "typescript-plugin-css-modules": "^5.0.2"
  }
}
</file>

<file path="rollup.config.mjs">
import { libraryConfig } from '@treenity/build-utils/library-config.js';

const inputs = [
  'src/index.ts',
  'src/utils.ts',
  'src/hooks.ts',
  'src/store.ts',
  'src/theme.ts',
  'src/form.ts',
];

export default [
  libraryConfig(inputs, 'browser', {
    check: false,
    only: true,
    external: ['react', 'react-dom', '@emotion/react', '@emotion/styled'],
  }),
];
</file>

<file path="tsconfig.json">
{
  "extends": "@treenity/tsconfig/react-library.json",
  "include": ["src"],
  "skipLibCheck": true,
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    },
    "plugins": [
      {
        "name": "typescript-plugin-css-modules"
      }
    ]
  }
}
</file>

</files>
