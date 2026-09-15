param(
  [Parameter(Mandatory = $true)][string]$ReferenceDirectory,
  [string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent)
)
# Build-only: pwsh 7 with bundled Roslyn plus Microsoft net462 reference assemblies.
# No SDK/compiler is installed or required on pharmacy PCs.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.CodeAnalysis
Add-Type -AssemblyName Microsoft.CodeAnalysis.CSharp
$source = Join-Path $RepositoryRoot 'windows-agent-production/PharmFarm-AgentHost.cs'
$output = Join-Path $RepositoryRoot 'windows-agent-production/PharmFarm-AgentHost.exe'
$tree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText([IO.File]::ReadAllText($source))
$references = [Microsoft.CodeAnalysis.MetadataReference[]]@(
  [Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile((Join-Path $ReferenceDirectory 'mscorlib.dll')),
  [Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile((Join-Path $ReferenceDirectory 'System.dll'))
)
$options = [Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions]::new([Microsoft.CodeAnalysis.OutputKind]::WindowsApplication).
  WithPlatform([Microsoft.CodeAnalysis.Platform]::AnyCpu).
  WithOptimizationLevel([Microsoft.CodeAnalysis.OptimizationLevel]::Release).WithDeterministic($true)
$compilation = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create('PharmFarm-AgentHost', [Microsoft.CodeAnalysis.SyntaxTree[]]@($tree), $references, $options)
$stream = [IO.File]::Create($output)
try {
  $result = $compilation.Emit($stream)
  if (!$result.Success) { throw ($result.Diagnostics -join [Environment]::NewLine) }
} finally { $stream.Dispose() }
Get-FileHash $output -Algorithm SHA256
