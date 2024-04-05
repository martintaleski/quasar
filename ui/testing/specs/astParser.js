import { Parser } from 'acorn'

const astNodeTypes = [
  'ExportNamedDeclaration', 'ExportDefaultDeclaration',
  'VariableDeclaration', 'ClassDeclaration', 'FunctionDeclaration'
]

function getAstAssignmentPattern (node, canComment) {
  const left = canComment ? `/* ${ getAstParam(node.left, false) } */ ` : ''
  const right = getAstParam(node.right, false)

  return left + right
}

function getAstObjectPattern (node, canComment) {
  const body = node.properties
    .map(prop => getAstParam(prop.value, canComment))
    .join(', ')

  return `{ ${ body } }`
}

function getAstMemberExpression (node) {
  const left = node.object.type === 'MemberExpression'
    ? getAstAssignmentPattern(node.object)
    : node.object.name

  const right = node.property.value

  return `${ left }.${ right }`
}

function getAstParam (param, canComment) {
  if (param.type === 'ArrowFunctionExpression') {
    return `(${ getParams(param.params, false) }) => {}`
  }

  if (param.type === 'Identifier') {
    return param.name
  }

  if (param.type === 'Literal') {
    return '' + param.value
  }

  if (param.type === 'NewExpression') {
    return `new ${ param.callee.name }(${ getParams(param.arguments, false) })`
  }

  if (param.type === 'MemberExpression') {
    return getAstMemberExpression(param)
  }

  if (param.type === 'ObjectPattern') {
    return getAstObjectPattern(param, canComment)
  }

  if (param.type === 'ObjectExpression') {
    return '{}'
  }

  if (param.type === 'ArrayExpression') {
    return '[]'
  }

  if (param.type === 'AssignmentPattern') {
    return getAstAssignmentPattern(param, canComment)
  }

  console.error('param:', param)
  throw new Error('astParser - getAstParam(): unknown param case')
}

function getParams (params, canComment = true) {
  const list = params.map(param => getAstParam(param, canComment))
  return list.join(', ') || ''
}

function parseVar ({ accessor, isExported = false }) {
  return {
    jsonKey: 'variables',
    isExported,
    def: {
      accessor
    }
  }
}

function parseClass ({ declaration, accessor, isExported = false }) {
  const constructorEntry = declaration.body.body.find(
    entry => entry.kind === 'constructor'
  )

  return {
    jsonKey: 'classes',
    isExported,
    def: {
      accessor,
      constructorParams: getParams(constructorEntry?.value.params)
    }
  }
}

function parseFunction ({ declaration, accessor, isExported = false }) {
  return {
    jsonKey: 'functions',
    isExported,
    def: {
      accessor,
      params: getParams(declaration.params)
    }
  }
}

export function getImportStatement ({ ctx, json }) {
  const list = []
  if (json.defaultExport === true) {
    list.push(ctx.pascalName)
  }
  if (json.namedExports.size !== 0) {
    list.push(`{ ${ Array.from(json.namedExports).join(', ') } }`)
  }
  return `import ${ list.join(', ') } from './${ ctx.localName }'`
}

export function readAstJson (ctx) {
  const { body } = Parser.parse(ctx.targetContent, {
    ecmaVersion: 'latest',
    sourceType: 'module'
  })

  const nodeList = body.filter(({ type }) => astNodeTypes.includes(type))
  const content = {}

  nodeList.forEach(node => {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration?.type === void 0) {
        console.error(
          'AST: unknown ExportNamedDeclaration > declaration for:',
          ctx.targetAbsolute
        )
        console.error('declaration', node.declaration)
        console.error('ctx', ctx)
        throw new Error('readAstJson > unknown ExportNamedDeclaration > declaration')
      }
      if (node.declaration.type === 'VariableDeclaration') {
        node.declaration.declarations.forEach(declaration => {
          if (
            declaration.type === 'VariableDeclaration'
            || declaration.type === 'VariableDeclarator'
          ) {
            content[ declaration.id.name ] = parseVar({ isExported: true })
          }
          else if (declaration.type === 'FunctionDeclaration') {
            content[ declaration.id.name ] = parseFunction({
              declaration,
              isExported: true
            })
          }
          else {
            console.error(
              'AST: unknown ExportNamedDeclaration > VariableDeclaration > type:',
              declaration.type,
              'for:',
              ctx.targetAbsolute
            )
            console.error('declaration', declaration)
            console.error('ctx', ctx)
            throw new Error('readAstJson > unknown ExportNamedDeclaration > VariableDeclaration > type')
          }
        })
      }
      else if (node.declaration.type === 'ClassDeclaration') {
        content[ node.declaration.id.name ] = parseClass({
          declaration: node.declaration,
          isExported: true
        })
      }
      else if (node.declaration.type === 'FunctionDeclaration') {
        content[ node.declaration.id.name ] = parseFunction({
          declaration: node.declaration,
          isExported: true
        })
      }
    }
    else if (node.type === 'VariableDeclaration') {
      node.declarations.forEach(declaration => {
        content[ declaration.id.name ] = parseVar({})
      })
    }
    else if (node.type === 'FunctionDeclaration') {
      content[ node.id.name ] = parseFunction({ declaration: node })
    }
  })

  const json = {
    defaultExport: void 0,
    namedExports: new Set(),
    variables: {},
    classes: {},
    functions: {}
  }

  // now we fill the json object with the default export stuff
  nodeList.forEach(({ type, declaration }) => {
    if (type !== 'ExportDefaultDeclaration') return

    // export { ... }
    if (declaration.type === 'ObjectExpression') {
      declaration.properties.forEach(prop => {
        const { name } = prop.key
        const { name: ref } = (prop.value || prop.key)

        if (content[ ref ] === void 0) {
          console.error(
            'AST: unregistered ExportDefaultDeclaration > ObjectExpression > properties:',
            name,
            'for:', ctx.targetAbsolute
          )
          console.error('prop', prop)
          console.error('ctx', ctx)
          throw new Error('readAstJson > unregistered ExportDefaultDeclaration > ObjectExpression > properties')
        }

        const { jsonKey, def } = content[ ref ]
        delete content[ ref ]

        def.accessor = `${ ctx.pascalName }.${ name }`
        json[ jsonKey ][ name ] = def
        json.defaultExport = true
      })
    }
    // export default function () {}
    else if (
      declaration.type === 'FunctionDeclaration'
      || declaration.type === 'ArrowFunctionExpression'
    ) {
      const { def } = parseFunction({
        declaration,
        accessor: ctx.pascalName
      })

      json.functions.default = def
      json.defaultExport = true
    }
    // export default class X {}
    else if (declaration.type === 'ClassDeclaration') {
      const { def } = parseClass({
        declaration,
        accessor: ctx.pascalName
      })

      json.classes.default = def
      json.defaultExport = true
    }
  })

  // is there anything else name exported?
  Object.keys(content).forEach(name => {
    const { jsonKey, isExported, def } = content[ name ]
    if (isExported === true) {
      json[ jsonKey ][ name ] = def
      def.accessor = name
      json.namedExports.add(name)
    }
  })

  const hasVariables = Object.keys(json.variables).length !== 0
  const hasClasses = Object.keys(json.classes).length !== 0
  const hasFunctions = Object.keys(json.functions).length !== 0

  if (
    hasVariables === false
    && hasClasses === false
    && hasFunctions === false
  ) {
    console.error('AST: no variables, classes or functions found for:', ctx.targetAbsolute)
    console.error('ctx', ctx)
    throw new Error('readAstJson > no variables, classes or functions found')
  }

  if (hasVariables === false) {
    delete json.variables
  }

  if (hasClasses === false) {
    delete json.classes
  }

  if (hasFunctions === false) {
    delete json.functions
  }

  return json
}