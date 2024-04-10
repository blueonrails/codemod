import { ExpressionKind } from 'ast-types/gen/kinds'
import { API, Collection, FileInfo, Identifier, JSCodeshift, ObjectProperty, VariableDeclarator } from 'jscodeshift'
import prettier, { Options } from 'prettier'

const SPECIAL_THROWS_CASE = '(special throws case)'
const SPECIAL_BOOL = '(special bool case)'
const SPECIAL_PLAN_CASE = '(special plan case)'

const tPropertiesMap = {
  ok: 'toBeTruthy',
  truthy: 'toBeTruthy',
  falsy: 'toBeFalsy',
  notOk: 'toBeFalsy',
  true: SPECIAL_BOOL,
  false: SPECIAL_BOOL,
  is: 'toBe',
  not: 'not.toBe',
  same: 'toEqual',
  deepEqual: 'toEqual',
  notSame: 'not.toEqual',
  notDeepEqual: 'not.toEqual',
  throws: SPECIAL_THROWS_CASE,
  notThrows: SPECIAL_THROWS_CASE,
  regex: 'toMatch',
  notRegex: 'not.toMatch',
  ifError: 'toBeFalsy',
  error: 'toBeFalsy',
  plan: SPECIAL_PLAN_CASE,
  snapshot: 'toMatchSnapshot'
}

const tPropertiesNotMapped = new Set(['end', 'fail', 'pass'])

const avaToJestLifecycleMethods = {
  before: 'beforeAll',
  after: 'afterAll',
  beforeEach: 'beforeEach',
  afterEach: 'afterEach',
  only: 'test.only',
  skip: 'test.skip',
  failing: 'test.skip',
  todo: 'test.todo'
}

export default function transformer (file: FileInfo, api: API) {
  const j = api.jscodeshift
  const root: Collection<any> = j(file.source)

  removeImport(j, root)
  generateSharedContext(j, root)
  updateSharedContextReferences(j, root)
  adjustTestDefinitions(j, root)
  updateAssertions(j, root)
  rewriteTestCallExpression(j, root)

  const generatedCode = root.toSource({quote: 'single', trailingComma: false})

  const prettierConfig: Options = {
    semi: false,
    singleQuote: true,
    parser: 'babel-ts',
    trailingComma: 'none',
    printWidth: 140
  }

  return prettier.format(generatedCode, prettierConfig)
}

function removeImport (j: JSCodeshift, root: Collection<any>) {
  root.find(j.ImportDeclaration, {
    source: {
      value: 'ava'
    }
  }).forEach((p: any) => {
    p.prune()
  })
}

function generateSharedContext (j: JSCodeshift, root: Collection<any>) {
  // 1. get test variable
  const testVariableDeclarator = root.find(j.VariableDeclarator, {
    id: {
      name: 'test'
    }
  })

  if (!testVariableDeclarator.length) {
    console.log('No test variable found.')
    return
  }

  const testVariable = testVariableDeclarator.nodes()[0]

  if (!testVariable.init || testVariable.init.type !== 'TSAsExpression' || testVariable.init.typeAnnotation.type !== 'TSTypeReference') {
    console.log('No test variable foun or invalid type.')
    return
  }

  const typeAnnotation = testVariable.init.typeAnnotation

  // 2.
  // create type SharedContextType
  // remove old test variable
  if (!typeAnnotation?.typeParameters?.params || typeAnnotation?.typeParameters?.params?.length === 0) {
    console.log('No type parameters found in TestFn.')
    return
  }

  const specificType = typeAnnotation.typeParameters.params[0]

  const sharedContextType = j.tsTypeAliasDeclaration(
    j.identifier('SharedContextType'),
    specificType
  )

  // 3. create shared context variable
  if (specificType.type !== 'TSTypeLiteral') {
    console.log('Invalid type literal.')
    return
  }

  const properties: ObjectProperty[] = specificType.members.map((member: any) => {
    if (member.type === 'TSPropertySignature' && member.key.type === 'Identifier') {
      return j.objectProperty(j.identifier(member.key.name), j.nullLiteral())
    }
  }).filter(Boolean) as ObjectProperty[]

  // Crear la declaración de la variable 'test' con las propiedades dinámicas
  const testVariableDeclaration = j.variableDeclaration('const', [
    j.variableDeclarator(
      j.identifier('sharedContext'),
      j.objectExpression(properties)
    )
  ])

  const variableDeclaration: VariableDeclarator = testVariableDeclaration.declarations[0] as VariableDeclarator

  if (variableDeclaration.id.type === 'Identifier') {
    (variableDeclaration.id as Identifier).typeAnnotation = j.tsTypeAnnotation(j.tsTypeReference(j.identifier('SharedContextType')))
  }
  // 4. insert test type and new variable
  const testVariableStatement = testVariableDeclarator.closest(j.Statement)

  testVariableStatement.insertBefore(sharedContextType)
  testVariableStatement.insertAfter(testVariableDeclaration)

  // remove old variable test
  j(testVariableDeclarator.get()).remove()
}

function updateSharedContextReferences (j: JSCodeshift, root: Collection<any>) {
  // Encuentra todos los accesos a t.context en el archivo
  root.find(j.MemberExpression, {
    object: {
      type: 'Identifier',
      name: 't'
    },
    property: {
      type: 'Identifier',
      name: 'context'
    }
  }).replaceWith(() => {
    // Reemplaza t.context por sharedContext
    return j.identifier('sharedContext')
  })
}

function adjustTestDefinitions (j: JSCodeshift, root: Collection<any>) {
  root.find(j.CallExpression, {
    callee: {
      name: 'test'
    }
  }).forEach((path: any) => {
    if (path.value.arguments.length > 1 && (j.ArrowFunctionExpression.check(path.value.arguments[1]) || j.FunctionExpression.check(path.value.arguments[1]))) {

      const testFunction = path.value.arguments[1]

      if (testFunction.params.length > 0) {
        testFunction.params = []
      }
    }
  })
}

function updateAssertions (j: JSCodeshift, root: Collection<any>) {
  root.find(j.CallExpression, {
    callee: {
      object: { name: 't' },
      property: (node: any) => !tPropertiesNotMapped.has(node.name)
    }
  }).forEach((path: any) => {
    const args = path.node.arguments
    const oldPropertyName: keyof typeof tPropertiesMap = path.value.callee.property.name
    const newPropertyName = tPropertiesMap[oldPropertyName]

    if (typeof newPropertyName === 'undefined') {
      console.warn(`"${oldPropertyName}" is currently not supported`)
      return
    }

    let newExpression

    if (newPropertyName === SPECIAL_BOOL) {
      // `true` or `false` specific assertion handling
      newExpression = j.expressionStatement(
        j.callExpression(
          j.memberExpression(j.callExpression(j.identifier('expect'), [args[0]]), j.identifier(oldPropertyName === 'true' ? 'toBeTruthy' : 'toBeFalsy')),
          []
        )
      )

    } else if (newPropertyName === SPECIAL_PLAN_CASE) {
      // Handling SPECIAL_PLAN_CASE
      newExpression = j.expressionStatement(
        j.callExpression(
          j.memberExpression(j.identifier('expect'), j.identifier('assertions')),
          [args[0]]
        )
      )

    } else if (newPropertyName === SPECIAL_THROWS_CASE) {
      // Handling throws/notThrows specifically
      const methodName = oldPropertyName === 'throws' ? 'toThrow' : 'not.toThrow'
      newExpression = j.expressionStatement(
        j.callExpression(
          j.memberExpression(j.callExpression(j.identifier('expect'), [j.functionExpression(null, [], j.blockStatement([]))]), j.identifier(methodName)),
          args.length > 1 ? [args[1]] : []
        )
      )

    } else {
      const jestMatcher = j.memberExpression(j.callExpression(j.identifier('expect'), [args[0]]), j.identifier(newPropertyName))
      newExpression = j.expressionStatement(
        j.callExpression(jestMatcher, [args[1]])
      )
    }

    j(path).replaceWith(newExpression)
  })
}

/**
 * Find the identifier from a given MemberExpression
 *
 * Example: return `foo` for a node of `foo.bar.baz()`
 *
 * @param  {ExpressionKind} node
 * @return {string|null}
 */
export function getIdentifierFromExpression (node: ExpressionKind) {
  if (!node) {
    return null
  }

  if (node.type === 'Identifier') {
    return node
  }

  return getIdentifierFromExpression((node as any).object)
}

function rewriteTestCallExpression (j: JSCodeshift, root: Collection<any>) {
  root.find(j.CallExpression, {
    callee: {
      type: 'MemberExpression',
      object: {
        name: 'test'
      }
    }
  })
  .forEach((path: any) => {
    const calleeProperty = path.node.callee.property

    const lifecycleMethod: keyof typeof avaToJestLifecycleMethods = calleeProperty.name

    if (Object.keys(avaToJestLifecycleMethods).includes(lifecycleMethod)) {
      const jestEquivalent = avaToJestLifecycleMethods[lifecycleMethod]
      path.node.callee = j.identifier(jestEquivalent)

      if (path.node.arguments.length > 0 && j.Literal.check(path.node.arguments[0]) && typeof path.node.arguments[0].value === 'string') {
        path.node.arguments.shift()
      }

      const callback = path.node.arguments[1]
      if (callback && (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression')) {
        if (callback.params.length > 0 && callback.params[0].name === 't') {
          callback.params.shift()
        }
      }
    }
  })
}
