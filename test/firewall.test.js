import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { allowScript } from '../server/firewall.js'

// Parses the generated rule script with PowerShell's own parser (nothing is run) and
// reports the parse error count and whether $program holds the path it was given.
const parser = `param([string]$Path, [string]$Expected)
$text = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
$assign = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$program' }, $true)
$value = if ($assign) { $assign.Right.Find({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true).Value } else { $null }
"errors=$($errors.Count) program=$($value -ceq $Expected)"
`

const programs = [
  'C:\\Program Files\\nodejs\\node.exe',
  "C:\\Users\\O'Brien\\node\\node.exe",
  'C:\\Users\\O\u2019Brien\\node\\node.exe',
  'C:\\Users\\O\u2018x\u201Ay\u201Bz\\node.exe',
  'C:\\Users\\山田 太郎\\$x `y &z\\node.exe',
]

test('the firewall rule script parses in PowerShell whatever quotes the program path has', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-firewall-'))
  try {
    const parserFile = path.join(dir, 'parse.ps1')
    const rulesFile = path.join(dir, 'rules.ps1')
    fs.writeFileSync(parserFile, parser)
    for (const program of programs) {
      fs.writeFileSync(rulesFile, allowScript({ program, port: 3000, address: '100.64.1.2', whatIf: true }), 'utf8')
      const result = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', parserFile, '-Path', rulesFile, '-Expected', program,
      ], { encoding: 'utf8' }).trim()
      assert.equal(result, 'errors=0 program=True', program)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
