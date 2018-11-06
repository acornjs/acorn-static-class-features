"use strict"

const skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g

const acorn = require("acorn")
const tt = acorn.tokTypes
const TokenType = acorn.TokenType

function maybeParseFieldValue(field) {
  if (this.eat(tt.eq)) {
    const oldInFieldValue = this._inStaticFieldValue
    this._inStaticFieldValue = true
    field.value = this.parseExpression()
    this._inStaticFieldValue = oldInFieldValue
  } else field.value = null
}

function parsePrivateName() {
  const node = this.startNode()
  node.name = this.value
  this.next()
  this.finishNode(node, "PrivateName")
  if (this.options.allowReserved == "never") this.checkUnreserved(node)
  return node
}

const privateNameToken = new TokenType("privateName")

module.exports = function(Parser) {
  return class extends Parser {
    // Parse # token
    getTokenFromCode(code) {
      if (code === 35) {
        ++this.pos
        const word = this.readWord1()
        return this.finishToken(privateNameToken, word)
      }
      return super.getTokenFromCode(code)
    }

    // Manage stacks and check for undeclared private static names
    parseClass(node, isStatement) {
      this._privateBoundNamesStack = this._privateBoundNamesStack || []
      const privateBoundNames = Object.create(this._privateBoundNamesStack[this._privateBoundNamesStack.length - 1] || null)
      this._privateBoundNamesStack.push(privateBoundNames)
      this._unresolvedPrivateNamesStack = this._unresolvedPrivateNamesStack || []
      const unresolvedPrivateNames = Object.create(null)
      this._unresolvedPrivateNamesStack.push(unresolvedPrivateNames)
      const _return = super.parseClass(node, isStatement)
      this._privateBoundNamesStack.pop()
      this._unresolvedPrivateNamesStack.pop()
      if (!this._unresolvedPrivateNamesStack.length) {
        const names = Object.keys(unresolvedPrivateNames)
        if (names.length) {
          names.sort((n1, n2) => unresolvedPrivateNames[n1] - unresolvedPrivateNames[n2])
          this.raise(unresolvedPrivateNames[names[0]], "Usage of undeclared private name")
        }
      } else Object.assign(this._unresolvedPrivateNamesStack[this._unresolvedPrivateNamesStack.length - 1], unresolvedPrivateNames)
      return _return
    }

    // Parse private fields
    parseClassElement(_constructorAllowsSuper) {
      if (this.eat(tt.semi)) return null

      const node = this.startNode()

      const tryContextual = (k, noLineBreak) => {
        if (typeof noLineBreak == "undefined") noLineBreak = false
        const start = this.start, startLoc = this.startLoc
        if (!this.eatContextual(k)) return false
        if (this.type !== tt.parenL && (!noLineBreak || !this.canInsertSemicolon())) return true
        if (node.key) this.unexpected()
        node.computed = false
        node.key = this.startNodeAt(start, startLoc)
        node.key.name = k
        this.finishNode(node.key, "Identifier")
        return false
      }

      node.static = tryContextual("static")
      if (!node.static) return super.parseClassElement.apply(this, arguments)

      let isGenerator = this.eat(tt.star)
      let isAsync = false
      if (!isGenerator) {
        // Special-case for `async`, since `parseClassMember` currently looks
        // for `(` to determine whether `async` is a method name
        if (this.options.ecmaVersion >= 8 && this.isContextual("async")) {
          skipWhiteSpace.lastIndex = this.pos
          let skip = skipWhiteSpace.exec(this.input)
          let next = this.input.charAt(this.pos + skip[0].length)
          if (next === ";" || next === "=") {
            node.key = this.parseIdent(true)
            node.computed = false
            maybeParseFieldValue.call(this, node)
            this.finishNode(node, "FieldDefinition")
            this.semicolon()
            return node
          } else if (this.options.ecmaVersion >= 8 && tryContextual("async", true)) {
            isAsync = true
            isGenerator = this.options.ecmaVersion >= 9 && this.eat(tt.star)
          }
        } else if (tryContextual("get")) {
          node.kind = "get"
        } else if (tryContextual("set")) {
          node.kind = "set"
        }
      }
      if (this.type.label === privateNameToken.label) { // Don't use object identity for interop with private-methods
        node.key = parsePrivateName.call(this)
        node.computed = false
        if (node.key.name === "constructor") {
          this.raise(node.key.start, "Classes may not have a private static property named constructor")
        }

        const privateBoundNames = this._privateBoundNamesStack[this._privateBoundNamesStack.length - 1]
        if (Object.prototype.hasOwnProperty.call(privateBoundNames, node.key.name) && !(node.kind === "get" && privateBoundNames[node.key.name] === "set") && !(node.kind === "set" && privateBoundNames[node.key.name] === "get")) this.raise(node.start, "Duplicate private element")
        privateBoundNames[node.key.name] = node.kind || true

        delete this._unresolvedPrivateNamesStack[this._unresolvedPrivateNamesStack.length - 1][node.key.name]
        if (this.type !== tt.parenL) {
          if (node.key.name === "prototype") {
            this.raise(node.key.start, "Classes may not have a private static property named prototype")
          }
          maybeParseFieldValue.call(this, node)
          this.finishNode(node, "FieldDefinition")
          this.semicolon()
          return node
        }
      } else if (!node.key) {
        this.parsePropertyName(node)
        if ((node.key.name || node.key.value) === "prototype" && !node.computed) {
          this.raise(node.key.start, "Classes may not have a static property named prototype")
        }
      }
      if (!node.kind) node.kind = "method"
      this.parseClassMethod(node, isGenerator, isAsync)
      if (!node.kind && (node.key.name || node.key.value) === "constructor" && !node.computed) {
        this.raise(node.key.start, "Classes may not have a static field named constructor")
      }
      if (node.kind === "get" && node.value.params.length !== 0) {
        this.raiseRecoverable(node.value.start, "getter should have no params")
      }
      if (node.kind === "set" && node.value.params.length !== 1) {
        this.raiseRecoverable(node.value.start, "setter should have exactly one param")
      }
      if (node.kind === "set" && node.value.params[0].type === "RestElement") {
        this.raiseRecoverable(node.value.params[0].start, "Setter cannot use rest params")
      }

      return node

    }

    // Parse public static fields
    parseClassMethod(method, isGenerator, isAsync, _allowsDirectSuper) {
      if (isGenerator || isAsync || method.kind != "method" || !method.static || this.options.ecmaVersion < 8 || this.type == tt.parenL) {
        const oldInPrivateClassMethod = this._inPrivateClassMethod
        this._inPrivateClassMethod = method.key.type == "PrivateName"
        const ret = super.parseClassMethod.apply(this, arguments)
        this._inPrivateClassMethod = oldInPrivateClassMethod
        return ret
      }
      maybeParseFieldValue.call(this, method)
      delete method.kind
      method = this.finishNode(method, "FieldDefinition")
      this.semicolon()
      return method
    }

    // Parse private element access
    parseSubscripts(base, startPos, startLoc, noCalls) {
      for (let computed; ;) {
        if ((computed = this.eat(tt.bracketL)) || this.eat(tt.dot)) {
          let node = this.startNodeAt(startPos, startLoc)
          node.object = base
          if (computed) {
            node.property = this.parseExpression()
          } else if (this.type.label === privateNameToken.label) { // Don't use object identity for interop with private-methods
            node.property = parsePrivateName.call(this)
            if (!this._privateBoundNamesStack.length || !this._privateBoundNamesStack[this._privateBoundNamesStack.length - 1][node.property.name]) {
              this._unresolvedPrivateNamesStack[this._unresolvedPrivateNamesStack.length - 1][node.property.name] = node.property.start
            }
          } else {
            node.property = this.parseIdent(true)
          }
          node.computed = Boolean(computed)
          if (computed) this.expect(tt.bracketR)
          base = this.finishNode(node, "MemberExpression")
        } else {
          return super.parseSubscripts(base, startPos, startLoc, noCalls)
        }
      }
    }

    // Prohibit delete of private class elements
    parseMaybeUnary(refDestructuringErrors, sawUnary) {
      const _return = super.parseMaybeUnary(refDestructuringErrors, sawUnary)
      if (_return.operator == "delete") {
        if (_return.argument.type == "MemberExpression" && _return.argument.property.type == "PrivateName") {
          this.raise(_return.start, "Private elements may not be deleted")
        }
      }
      return _return
    }

    // Prohibit arguments in class field initializers
    parseIdent(liberal, isBinding) {
      const ident = super.parseIdent(liberal, isBinding)
      if (this._inStaticFieldValue && ident.name == "arguments") this.raise(ident.start, "A static class field initializer may not contain arguments")
      return ident
    }

    // Prohibit super in class field initializers
    // Prohibit direct super in private methods
    // FIXME: This is not necessary in acorn >= 6.0.3
    parseExprAtom(refDestructuringErrors) {
      const atom = super.parseExprAtom(refDestructuringErrors)
      if (this._inStaticFieldValue && atom.type == "Super") this.raise(atom.start, "A static class field initializer may not contain super")
      if (this._inPrivateClassMethod && atom.type == "Super" && this.type == tt.parenL) this.raise(atom.start, "A class method that is not a constructor may not contain a direct super")
      return atom
    }
  }
}
