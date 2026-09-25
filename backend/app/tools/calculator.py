"""Calculator Tool — mirrors backend/src/services/tools/calculator.ts.

Safely evaluates math expressions with a recursive-descent parser (no eval).
"""

from __future__ import annotations

import math
import re
from typing import Any, Callable

from ..logger import info as log_info
from . import ToolContext, ToolDefinition, ToolParam, ToolResult, register_tool

MATH_FUNCS = {
    "abs", "floor", "ceil", "round", "sqrt", "cbrt",
    "sin", "cos", "tan", "asin", "acos", "atan",
    "log", "log2", "log10", "ln", "exp", "pow", "max", "min", "pi", "e",
}

MATH_CONSTANTS: dict[str, float] = {"pi": math.pi, "e": math.e}


class _EvalState:
    def __init__(self) -> None:
        self.tokens: list[tuple[str, Any]] = []
        self.pos = 0

    def peek(self) -> tuple[str, Any] | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def consume(self) -> tuple[str, Any] | None:
        tok = self.peek()
        if tok is not None:
            self.pos += 1
        return tok


def _tokenize(expr: str) -> list[tuple[str, Any]]:
    tokens: list[tuple[str, Any]] = []
    i = 0
    while i < len(expr):
        ch = expr[i]
        if ch.isspace():
            i += 1
            continue
        if ch.isdigit():
            num = ""
            while i < len(expr) and (expr[i].isdigit() or expr[i] == "."):
                num += expr[i]
                i += 1
            tokens.append(("number", float(num)))
            continue
        if ch.isalpha() or ch == "_":
            name = ""
            while i < len(expr) and (expr[i].isalnum() or expr[i] == "_"):
                name += expr[i]
                i += 1
            if name.lower() in MATH_CONSTANTS:
                tokens.append(("number", MATH_CONSTANTS[name.lower()]))
            elif name.lower() in MATH_FUNCS:
                tokens.append(("func", name.lower()))
            else:
                tokens.append(("ident", name))
            continue
        if ch in "+-*/^%":
            tokens.append(("op", ch))
            i += 1
            continue
        if ch in "()":
            tokens.append(("paren", ch))
            i += 1
            continue
        if ch == ",":
            tokens.append(("comma", ch))
            i += 1
            continue
        i += 1  # Unknown char — skip
    return tokens


def _apply_function(name: str, args: list[float]) -> float:
    if name == "abs":
        return abs(args[0])
    if name == "floor":
        return math.floor(args[0])
    if name == "ceil":
        return math.ceil(args[0])
    if name == "round":
        return round(args[0])
    if name == "sqrt":
        return math.sqrt(args[0])
    if name == "cbrt":
        return math.copysign(abs(args[0]) ** (1 / 3), args[0])
    if name == "sin":
        return math.sin(args[0])
    if name == "cos":
        return math.cos(args[0])
    if name == "tan":
        return math.tan(args[0])
    if name == "asin":
        return math.asin(args[0])
    if name == "acos":
        return math.acos(args[0])
    if name == "atan":
        return math.atan(args[0])
    if name in ("log", "log10"):
        return math.log10(args[0])
    if name == "log2":
        return math.log2(args[0])
    if name == "ln":
        return math.log(args[0])
    if name == "exp":
        return math.exp(args[0])
    if name == "pow":
        return math.pow(args[0], args[1] if len(args) > 1 else 1)
    if name == "max":
        return max(args)
    if name == "min":
        return min(args)
    raise ValueError(f"Unknown function: {name}")


class _Parser:
    def __init__(self, tokens: list[tuple[str, Any]]) -> None:
        self.st = _EvalState()
        self.st.tokens = tokens

    def parse_expression(self) -> float:
        return self._additive()

    def _primary(self) -> float:
        tok = self.st.peek()
        if tok is None:
            raise ValueError("Unexpected end of expression")
        kind, value = tok
        if kind == "number":
            self.st.consume()
            return value
        if kind == "paren" and value == "(":
            self.st.consume()
            val = self.parse_expression()
            close = self.st.consume()
            if close is None or close[0] != "paren" or close[1] != ")":
                raise ValueError("Missing closing parenthesis")
            return val
        if kind == "func":
            self.st.consume()
            nxt = self.st.peek()
            if nxt and nxt[0] == "paren" and nxt[1] == "(":
                self.st.consume()
                args: list[float] = []
                while not (self.st.peek() and self.st.peek()[0] == "paren" and self.st.peek()[1] == ")"):
                    if self.st.peek() is None:
                        raise ValueError("Missing closing parenthesis")
                    args.append(self.parse_expression())
                    if self.st.peek() and self.st.peek()[0] == "comma":
                        self.st.consume()
                self.st.consume()  # eat ')'
                return _apply_function(value, args)
            return _apply_function(value, [])
        if kind == "op" and value == "-":
            self.st.consume()
            return -self._primary()
        if kind == "op" and value == "+":
            self.st.consume()
            return self._primary()
        raise ValueError(f"Unexpected token: {tok}")

    def _exponent(self) -> float:
        left = self._primary()
        while self.st.peek() and self.st.peek()[0] == "op" and self.st.peek()[1] == "^":
            self.st.consume()
            right = self._exponent()
            left = math.pow(left, right)
        return left

    def _multiplicative(self) -> float:
        left = self._exponent()
        while self.st.peek() and self.st.peek()[0] == "op" and self.st.peek()[1] in "*/%":
            op = self.st.consume()[1]
            right = self._exponent()
            if op == "*":
                left *= right
            elif op == "/":
                if right == 0:
                    raise ValueError("Division by zero")
                left /= right
            else:
                if right == 0:
                    raise ValueError("Division by zero (modulo)")
                left %= right
        return left

    def _additive(self) -> float:
        left = self._multiplicative()
        while self.st.peek() and self.st.peek()[0] == "op" and self.st.peek()[1] in "+-":
            op = self.st.consume()[1]
            right = self._multiplicative()
            left = left + right if op == "+" else left - right
        return left


def safe_eval(expr: str) -> float:
    parser = _Parser(_tokenize(expr))
    result = parser.parse_expression()
    if parser.st.peek() is not None:
        raise ValueError("Unexpected tokens after expression")
    return result


DEFINITION = ToolDefinition(
    id="calculator",
    name="Calculator",
    description="Evaluate math expressions: arithmetic, trigonometry, logarithms, powers, and more",
    version="1.0.0",
    icon="\U0001f9ee",
    params=[
        ToolParam(
            name="expression",
            type="string",
            description='Math expression to evaluate (e.g., "2 + 2", "sqrt(144)", "sin(45)")',
            required=True,
        ),
    ],
)


async def execute(params: dict[str, Any], ctx: ToolContext) -> ToolResult:
    expr = str(params.get("expression") or params.get("query") or "")
    if not expr.strip():
        return ToolResult(success=False, output="Please provide a math expression to evaluate.")
    try:
        result = safe_eval(expr)
        formatted = str(int(result)) if float(result).is_integer() else f"{result:.4f}"
        return ToolResult(
            success=True,
            output=f"{expr} = {formatted}",
            data={"expression": expr, "result": result},
        )
    except Exception as e:  # noqa: BLE001
        return ToolResult(success=False, output=f'Could not evaluate "{expr}": {e}')


CALC_PATTERNS = [
    re.compile(r"(\d+)\s*([+\-*/^])\s*(\d+)"),
    re.compile(r"calculate\s+(.+)", re.IGNORECASE),
    re.compile(r"what (is|'s)\s+(.+)"),
    re.compile(r"compute\s+(.+)", re.IGNORECASE),
    re.compile(r"solve\s+(.+)", re.IGNORECASE),
]


def detect(input_text: str) -> dict[str, Any] | None:
    """Auto-detect calculator intent from user input."""
    lower = input_text.lower()
    if any(k in lower for k in ("convert", "cm", "inches", "feet")):
        return None
    if re.search(r"[\d]\s*[+\-*/^%]\s*[\d]", input_text) and "http" not in lower:
        return {"confidence": 0.8, "params": {"expression": input_text.strip()}}
    for pat in CALC_PATTERNS:
        m = pat.search(input_text)
        if m:
            expr = m.group(m.lastindex or 1).strip() if m.groups() else ""
            if not expr:
                continue
            if 0 < len(expr) < 200:
                return {"confidence": 0.7, "params": {"expression": expr}}
    return None


def register_calculator_tool() -> None:
    register_tool(DEFINITION, execute)
    log_info("[tools] Calculator registered with safe math evaluator")
