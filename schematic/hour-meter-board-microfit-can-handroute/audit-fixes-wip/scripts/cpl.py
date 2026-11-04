import importlib.util, sys, os
spec = importlib.util.spec_from_file_location('tp', '/home/ilomon/Projects/embedded-projects/totalizer-hour-meter/schematic/hour-meter-board-microfit-can/tools-pcb.py')
tp = importlib.util.module_from_spec(spec); spec.loader.exec_module(tp)
tp.HERE = '/tmp/claude-1000/-home-ilomon-Projects-embedded-projects-totalizer-hour-meter/64c8d7c4-1bde-47ca-8858-3552cbd044be/scratchpad/audit/board'
tp.PCB = '/tmp/claude-1000/-home-ilomon-Projects-embedded-projects-totalizer-hour-meter/64c8d7c4-1bde-47ca-8858-3552cbd044be/scratchpad/audit/board/hour-meter-board-microfit-can-handroute.kicad_pcb'
tp.jlc_cpl()
