using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LocalDshJob {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public uint cb; public IntPtr reserved, desktop, title;
    public uint x,y,xSize,ySize,xCount,yCount,fill,flags;
    public ushort show,reservedSize; public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking;
    public uint activeProcesses; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref EXTENDED_LIMIT limits,uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Quote(string s) {
    var result = new StringBuilder("\""); int slashes=0;
    foreach(char c in s) {
      if(c=='\\') { slashes++; continue; }
      if(c=='\"') result.Append('\\',slashes*2+1).Append(c);
      else result.Append('\\',slashes).Append(c);
      slashes=0;
    }
    return result.Append('\\',slashes*2).Append('"').ToString();
  }
  public static int Run(string node,string entry,string patch) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); PROCESS_INFORMATION pi=new PROCESS_INFORMATION();
    if(job==IntPtr.Zero) throw new Exception("CreateJobObject failed");
    try {
      var limits=new EXTENDED_LIMIT(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))) throw new Exception("Job limits failed");
      var si=new STARTUPINFO(); si.cb=(uint)Marshal.SizeOf(si); si.flags=0x100;
      si.input=GetStdHandle(-10); si.output=GetStdHandle(-11); si.error=GetStdHandle(-12);
      var args=new StringBuilder(Quote(node)+" "+Quote(entry)+" --profile headless --patch "+Quote(patch)+" --json -");
      if(!CreateProcess(node,args,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref si,out pi)) throw new Exception("Suspended launch failed");
      if(!AssignProcessToJobObject(job,pi.process)) { TerminateProcess(pi.process,1); throw new Exception("Job assignment failed; DSH was not started"); }
      Console.Error.WriteLine("LOCAL_DSH_JOB_READY");
      if(ResumeThread(pi.thread)==0xffffffff) { TerminateProcess(pi.process,1); throw new Exception("Resume failed"); }
      WaitForSingleObject(pi.process,0xffffffff); uint code;
      if(!GetExitCodeProcess(pi.process,out code)) throw new Exception("Exit code unavailable");
      return (int)code;
    } finally {
      CloseHandle(job);
      if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);
      if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
    }
  }
  public static int Main(string[] args) {
    try { if(args.Length != 3) throw new Exception(); return Run(args[0],args[1],args[2]); }
    catch { Console.Error.WriteLine("LOCAL_DSH_JOB_FAILED: launch containment failed"); return 1; }
  }
}
